import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Scans MCP query logs for failed/weak searches and creates demand-driven gaps
// on relevant domain agents. Runs as a nightly cron step or on-demand.
export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const LOW_RELEVANCE_THRESHOLD = 0.5;
const REPEATED_MISS_THRESHOLD = 3;

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

// ─── Gemini fetch + helpers (retry on 429/5xx, token-usage logging) ─────────

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`;
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage };
        const usage = json.usageMetadata;
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }));
        }
        return { json, usage };
      }
      const txt = await resp.text().catch(() => '');
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`);
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('[gemini] request failed');
}

async function callGemini<T>(systemPrompt: string, userContent: string): Promise<T> {
  const { json } = await geminiFetch(
    `${GEMINI_MODEL}:generateContent`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    },
    30000,
    'council:detect-demand-gaps'
  );
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No Gemini response');
  return JSON.parse(text) as T;
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { json } = await geminiFetch(
      `${GEMINI_EMBEDDING_MODEL}:embedContent`,
      { model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text }] } },
      8000,
      'council:detect-demand-gaps:embed'
    );
    const data = json as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? [];
  } catch {
    return [];
  }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface QueryLogRow {
  id: string;
  user_id: string;
  tool_name: string;
  query_text: string;
  result_count: number;
  top_relevance: number | null;
  created_at: string;
}

interface DemandSignal {
  topic: string;
  query_texts: string[];
  query_log_ids: string[];
  user_id: string;
  miss_count: number;
  worst_relevance: number | null;
}

interface AgentMatch {
  agent_id: string;
  agent_name: string;
  similarity: number;
}

interface GeminiTopicResult {
  signals: Array<{
    queries: string[];
    topic: string;
    content_suggestion: string;
  }>;
}

// ─── STEP 1: FIND FAILED/WEAK QUERIES ────────────────────────────────────────

async function findDemandQueries(
  supabase: SupabaseClient,
  userId: string | null,
  lookbackHours: number
): Promise<QueryLogRow[]> {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  let query = supabase
    .from('mcp_query_log')
    .select('*')
    .gte('created_at', since)
    .or(`result_count.eq.0,top_relevance.lt.${LOW_RELEVANCE_THRESHOLD}`)
    .order('created_at', { ascending: false })
    .limit(200);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as QueryLogRow[];
}

// ─── STEP 2: CLUSTER INTO DEMAND SIGNALS ─────────────────────────────────────

async function clusterDemandSignals(queries: QueryLogRow[]): Promise<DemandSignal[]> {
  if (queries.length === 0) return [];

  // Group by user first
  const byUser = new Map<string, QueryLogRow[]>();
  for (const q of queries) {
    const arr = byUser.get(q.user_id) || [];
    arr.push(q);
    byUser.set(q.user_id, arr);
  }

  const signals: DemandSignal[] = [];

  for (const [userId, userQueries] of byUser) {
    // Use Gemini to cluster similar queries into topics
    if (userQueries.length === 1) {
      signals.push({
        topic: userQueries[0]!.query_text,
        query_texts: [userQueries[0]!.query_text],
        query_log_ids: [userQueries[0]!.id],
        user_id: userId,
        miss_count: 1,
        worst_relevance: userQueries[0]!.top_relevance,
      });
      continue;
    }

    // For multiple queries, ask Gemini to group them
    try {
      const queryList = userQueries.map(q => ({
        id: q.id,
        text: q.query_text,
        results: q.result_count,
        relevance: q.top_relevance,
      }));

      const result = await callGemini<GeminiTopicResult>(
        `You are grouping failed search queries into topic clusters for a knowledge management system.

Each query represents something the user searched for but couldn't find good results for.
Group queries that are about the same general topic together.
For each group, generate:
- topic: A clear, short topic name (2-5 words)
- content_suggestion: One sentence describing what kind of content would fill this knowledge gap
- queries: The list of query texts that belong to this group

Return JSON: { "signals": [{ "queries": ["query1", "query2"], "topic": "Topic Name", "content_suggestion": "..." }] }`,
        JSON.stringify(queryList)
      );

      for (const sig of (result.signals || [])) {
        const matchedQueries = userQueries.filter(q => sig.queries.includes(q.query_text));
        if (matchedQueries.length === 0) continue;

        signals.push({
          topic: sig.topic,
          query_texts: matchedQueries.map(q => q.query_text),
          query_log_ids: matchedQueries.map(q => q.id),
          user_id: userId,
          miss_count: matchedQueries.length,
          worst_relevance: Math.min(...matchedQueries.map(q => q.top_relevance ?? 0)),
        });
      }
    } catch (err) {
      logError({ stage: 'council:detect-demand-gaps', error: `Gemini clustering failed: ${err instanceof Error ? err.message : String(err)}`, status: 'partial' });
      // Fall back to treating each query as its own signal
      for (const q of userQueries) {
        signals.push({
          topic: q.query_text,
          query_texts: [q.query_text],
          query_log_ids: [q.id],
          user_id: userId,
          miss_count: 1,
          worst_relevance: q.top_relevance,
        });
      }
    }
  }

  return signals;
}

// ─── STEP 3: MATCH SIGNALS TO AGENTS ─────────────────────────────────────────

async function matchSignalToAgent(
  supabase: SupabaseClient,
  signal: DemandSignal
): Promise<AgentMatch | null> {
  // Generate embedding for the signal topic
  const embedding = await generateEmbedding(signal.topic + ' ' + signal.query_texts.join(' '));
  if (embedding.length === 0) return null;

  // Get all agents for this user with their expertise summaries
  const { data: agents } = await supabase
    .from('domain_agents')
    .select('id, name, description, expertise_index')
    .eq('user_id', signal.user_id)
    .eq('is_active', true);

  if (!agents || agents.length === 0) return null;

  // Compare signal embedding against each agent's description embedding
  // Since we don't store agent description embeddings, use text comparison via Gemini
  const agentSummaries = (agents as Array<{
    id: string; name: string; description: string | null;
    expertise_index: { summary?: string; core_themes?: string[] } | null
  }>).map(a => ({
    id: a.id,
    name: a.name,
    description: a.description || '',
    themes: (a.expertise_index?.core_themes || []).slice(0, 5).join(', '),
  }));

  try {
    const result = await callGemini<{ agent_id: string; agent_name: string; confidence: number; reason: string }>(
      `You are matching a knowledge gap to the most relevant domain expert.

Given a topic that a user searched for but couldn't find, determine which domain expert should own this gap.
Return the single best match with a confidence score (0.0-1.0).
If no agent is a good match (confidence < 0.3), return agent_id: "none".

Return JSON: { "agent_id": "uuid or none", "agent_name": "string", "confidence": 0.0-1.0, "reason": "brief justification" }`,
      `Topic: ${signal.topic}\nQueries: ${signal.query_texts.join(', ')}\n\nAvailable agents:\n${JSON.stringify(agentSummaries)}`
    );

    if (result.agent_id === 'none' || result.confidence < 0.3) return null;

    return {
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      similarity: result.confidence,
    };
  } catch {
    return null;
  }
}

// ─── STEP 4: CREATE/UPDATE DEMAND GAPS ───────────────────────────────────────

async function upsertDemandGap(
  supabase: SupabaseClient,
  signal: DemandSignal,
  agentMatch: AgentMatch,
  contentSuggestion: string
): Promise<{ created: boolean; gapId: string }> {
  // Check for existing demand gap on same topic for this agent
  const { data: existing } = await supabase
    .from('agent_gaps')
    .select('id, demand_count, query_log_ids')
    .eq('agent_id', agentMatch.agent_id)
    .eq('gap_type', 'demand')
    .eq('status', 'active')
    .ilike('topic', `%${signal.topic.slice(0, 30)}%`)
    .limit(1);

  if (existing && existing.length > 0) {
    const ex = existing[0] as { id: string; demand_count: number; query_log_ids: string[] };
    const newLogIds = [...new Set([...(ex.query_log_ids || []), ...signal.query_log_ids])];
    const newCount = (ex.demand_count || 0) + signal.miss_count;

    await supabase
      .from('agent_gaps')
      .update({
        demand_count: newCount,
        last_demanded_at: new Date().toISOString(),
        query_log_ids: newLogIds,
        severity: newCount >= REPEATED_MISS_THRESHOLD ? 'significant' : newCount >= 2 ? 'moderate' : 'minor',
        updated_at: new Date().toISOString(),
      })
      .eq('id', ex.id);

    return { created: false, gapId: ex.id };
  }

  // Create new demand gap
  const severity = signal.miss_count >= REPEATED_MISS_THRESHOLD ? 'significant'
    : signal.miss_count >= 2 ? 'moderate' : 'minor';

  const { data: newGap, error } = await supabase
    .from('agent_gaps')
    .insert({
      user_id: signal.user_id,
      agent_id: agentMatch.agent_id,
      gap_type: 'demand',
      topic: signal.topic,
      description: `User searched for "${signal.query_texts[0]}"${signal.miss_count > 1 ? ` and ${signal.miss_count - 1} similar queries` : ''} with no relevant results.`,
      severity,
      content_suggestion: contentSuggestion,
      demand_count: signal.miss_count,
      last_demanded_at: new Date().toISOString(),
      query_log_ids: signal.query_log_ids,
      status: 'active',
    })
    .select('id')
    .single();

  if (error) throw error;
  return { created: true, gapId: newGap.id };
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
    lookbackHours?: number;
    dryRun?: boolean;
  };
  const lookbackHours = body.lookbackHours ?? 24;
  const dryRun = body.dryRun === true;

  // Step 1: Find failed/weak queries
  const failedQueries = await findDemandQueries(supabase, userId, lookbackHours);

  if (failedQueries.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No failed queries in the lookback period',
      gapsCreated: 0,
      gapsUpdated: 0,
    });
  }

  // Step 2: Cluster into demand signals
  const signals = await clusterDemandSignals(failedQueries);

  if (dryRun) {
    return res.status(200).json({
      success: true,
      dryRun: true,
      failedQueries: failedQueries.length,
      demandSignals: signals.map(s => ({
        topic: s.topic,
        missCount: s.miss_count,
        queries: s.query_texts,
      })),
    });
  }

  // Step 3: Match to agents and create gaps
  let gapsCreated = 0;
  let gapsUpdated = 0;
  let unmatched = 0;
  const results: Array<{ topic: string; agentName: string | null; action: string }> = [];

  for (const signal of signals) {
    try {
      const agentMatch = await matchSignalToAgent(supabase, signal);

      if (!agentMatch) {
        unmatched++;
        results.push({ topic: signal.topic, agentName: null, action: 'no_agent_match' });
        continue;
      }

      // Generate content suggestion via the clustering step (or default)
      const contentSuggestion = `Add content about "${signal.topic}" — videos, articles, or documents covering this topic would fill this knowledge gap.`;

      const { created } = await upsertDemandGap(supabase, signal, agentMatch, contentSuggestion);

      if (created) {
        gapsCreated++;
        results.push({ topic: signal.topic, agentName: agentMatch.agent_name, action: 'gap_created' });
      } else {
        gapsUpdated++;
        results.push({ topic: signal.topic, agentName: agentMatch.agent_name, action: 'gap_updated' });
      }
    } catch (err) {
      logError({ stage: 'council:detect-demand-gaps', error: `error processing signal "${signal.topic}": ${err instanceof Error ? err.message : String(err)}`, status: 'partial' });
      results.push({ topic: signal.topic, agentName: null, action: 'error' });
    }
  }

  return res.status(200).json({
    success: true,
    failedQueries: failedQueries.length,
    demandSignals: signals.length,
    gapsCreated,
    gapsUpdated,
    unmatched,
    results,
    durationMs: Date.now() - startTime,
  });
}
