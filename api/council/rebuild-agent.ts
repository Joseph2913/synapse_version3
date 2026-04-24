import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Scoped single-agent rebuild. Runs expertise + questions + gaps + awareness
// for ONE domain_agent at a time so each invocation finishes inside Vercel's
// function budget. Mirrors the per-agent logic inside api/council/cron.ts
// phases 2-4 but bypasses the batch loop.
//
// Usage:
//   POST /api/council/rebuild-agent           with { agent_id } OR { next_stale: true }
//   Auth: Bearer CRON_SECRET, or a logged-in user JWT.

export const maxDuration = 600

// ─── ENV ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const CRON_SECRET = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface ExpertiseIndex {
  summary: string
  core_themes: string[]
  reasoning_approach: string
  strongest_areas: Array<{ topic: string; source_count: number; key_entities: string[] }>
  weakest_areas: Array<{ topic: string; reason: string }>
  cross_domain_bridges: Array<{
    target_agent_id: string
    target_agent_name: string
    bridge_description: string
    bridge_entity_ids: string[]
  }>
  generated_at: string
  source_count_at_generation: number
  entity_count_at_generation: number
}

interface Agent {
  id: string
  user_id: string
  name: string
  description: string | null
  expertise_index: ExpertiseIndex | Record<string, never>
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

function authorised(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  if (auth === `Bearer ${CRON_SECRET}`) return true
  return false
}

// ─── GEMINI ──────────────────────────────────────────────────────────────────

async function callGemini<T>(
  systemPrompt: string,
  userContent: string,
  timeoutMs = 90000,
  model = 'gemini-2.5-flash',
): Promise<T> {
  const response = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`,
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
    },
  )
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini ${response.status}: ${errText.slice(0, 300)}`)
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('No response from Gemini')
  return JSON.parse(text) as T
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!response.ok) return []
  const data = (await response.json()) as { embedding?: { values?: number[] } }
  return data.embedding?.values ?? []
}

// ─── STEP 1: expertise index + description + reasoning_style ────────────────

async function rebuildExpertise(supabase: SupabaseClient, agent: Agent): Promise<'ok' | 'no_sources'> {
  const { data: sources } = await supabase
    .from('domain_agent_sources')
    .select('source_id')
    .eq('agent_id', agent.id)

  const sourceIds = (sources ?? []).map((s) => (s as { source_id: string }).source_id)
  if (sourceIds.length === 0) return 'no_sources'

  const { data: entities } = await supabase
    .from('knowledge_nodes')
    .select('label, entity_type, description, confidence')
    .in('source_id', sourceIds)
    .eq('user_id', agent.user_id)
    .order('confidence', { ascending: false })
    .limit(200)

  const { data: sourceMeta } = await supabase
    .from('knowledge_sources')
    .select('title, summary, source_type')
    .in('id', sourceIds)
    .limit(50)

  const { data: recentSources } = await supabase
    .from('knowledge_sources')
    .select('id')
    .in('id', sourceIds)
    .order('created_at', { ascending: false })
    .limit(10)

  const recentSourceIds = (recentSources ?? []).map((s) => (s as { id: string }).id)
  let chunks: Array<{ content: string }> = []
  if (recentSourceIds.length > 0) {
    const { data: chunkData } = await supabase
      .from('source_chunks')
      .select('content')
      .in('source_id', recentSourceIds)
      .eq('user_id', agent.user_id)
      .limit(30)
    chunks = (chunkData ?? []) as Array<{ content: string }>
  }

  const { data: otherAgentsRaw } = await supabase
    .from('domain_agents')
    .select('id, name')
    .eq('user_id', agent.user_id)
    .neq('id', agent.id)

  const otherAgents = (otherAgentsRaw ?? []) as Array<{ id: string; name: string }>
  const entityCount = entities?.length ?? 0

  const systemPrompt = `You are an AI that generates structured expertise indexes for domain-specific knowledge agents.
Given a set of entities, source metadata, and representative content chunks, produce a JSON expertise index.

The output MUST conform to this exact JSON schema:
{
  "summary": "One paragraph overview of what this domain covers",
  "core_themes": ["array of 3-8 core themes"],
  "reasoning_approach": "How this domain reasons — extracted from content style",
  "strongest_areas": [
    { "topic": "string", "source_count": number, "key_entities": ["entity labels"] }
  ],
  "weakest_areas": [
    { "topic": "string", "reason": "string" }
  ],
  "cross_domain_bridges": [
    { "target_agent_id": "uuid", "target_agent_name": "string", "bridge_description": "string", "bridge_entity_ids": [] }
  ],
  "description": "A 2-3 sentence description of this advisor's domain expertise",
  "reasoning_style": "A sentence describing how this advisor reasons and approaches problems"
}

For cross_domain_bridges, identify which of the other agents listed might share conceptual overlap.
For strongest_areas, estimate source_count based on how many sources seem to cover each topic.
For weakest_areas, identify topics that seem underrepresented given the domain's scope.`

  const userContent = `Domain: ${agent.name}
Previous description: ${agent.description ?? 'None'}

Sources (${sourceIds.length} total):
${(sourceMeta ?? []).map((s) => `- ${(s as { title: string }).title} (${(s as { source_type: string }).source_type})`).join('\n')}

Top entities (${entityCount} total):
${(entities ?? []).slice(0, 100).map((e) => `- ${(e as { label: string }).label} [${(e as { entity_type: string }).entity_type}]${(e as { description: string | null }).description ? ': ' + ((e as { description: string }).description).slice(0, 80) : ''}`).join('\n')}

Representative content chunks:
${chunks.slice(0, 15).map((c) => c.content.slice(0, 300)).join('\n---\n')}

Other agents in the system:
${otherAgents.map((a) => `- ${a.name} (ID: ${a.id})`).join('\n')}`

  const result = await callGemini<ExpertiseIndex & { description?: string; reasoning_style?: string }>(
    systemPrompt,
    userContent,
    120000,
  )

  const expertiseIndex: ExpertiseIndex = {
    summary: result.summary || '',
    core_themes: result.core_themes || [],
    reasoning_approach: result.reasoning_approach || '',
    strongest_areas: result.strongest_areas || [],
    weakest_areas: result.weakest_areas || [],
    cross_domain_bridges: result.cross_domain_bridges || [],
    generated_at: new Date().toISOString(),
    source_count_at_generation: sourceIds.length,
    entity_count_at_generation: entityCount,
  }

  await supabase
    .from('domain_agents')
    .update({
      expertise_index: expertiseIndex,
      description: result.description || expertiseIndex.summary,
      reasoning_style: result.reasoning_style || expertiseIndex.reasoning_approach,
      source_count: sourceIds.length,
      entity_count: entityCount,
      last_index_rebuild_at: new Date().toISOString(),
      index_stale: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agent.id)

  // Mutate local agent so downstream steps see the fresh expertise_index.
  agent.expertise_index = expertiseIndex
  return 'ok'
}

// ─── STEP 2: standing questions + gaps ──────────────────────────────────────

async function regenerateQuestionsAndGaps(supabase: SupabaseClient, agent: Agent): Promise<void> {
  const expertise = agent.expertise_index as ExpertiseIndex
  if (!expertise?.summary) return

  const { data: existingQuestions } = await supabase
    .from('agent_standing_questions')
    .select('id, question_type, status')
    .eq('agent_id', agent.id)

  const existing = (existingQuestions ?? []) as Array<{ id: string; question_type: string; status: string }>

  const toArchive = existing
    .filter((q) => (q.question_type === 'gap_driven' || q.question_type === 'frontier') && q.status === 'open')
    .map((q) => q.id)

  if (toArchive.length > 0) {
    await supabase
      .from('agent_standing_questions')
      .update({ status: 'dismissed', status_changed_at: new Date().toISOString() })
      .in('id', toArchive)
  }

  const { data: existingGaps } = await supabase
    .from('agent_gaps')
    .select('id')
    .eq('agent_id', agent.id)
    .eq('status', 'active')

  const systemPrompt = `You are an AI that generates research questions and knowledge gaps for a domain-specific advisor.
Given an updated expertise index, produce fresh standing questions and gaps.

Output JSON:
{
  "standing_questions": [
    { "question": "string", "question_type": "gap_driven | frontier", "priority": 1-10, "trigger_description": "Why this question matters for this domain" }
  ],
  "gaps": [
    { "gap_type": "structural | orphan | recency", "topic": "string", "description": "string", "severity": "minor | moderate | significant", "content_suggestion": "string" }
  ],
  "resolved_gap_topics": ["topics from existing gaps that the expertise index now covers adequately"]
}

Generate 3-6 questions and 2-5 gaps. Be specific to the domain's current state.`

  const userContent = `Domain: ${agent.name}\n\nExpertise Index:\n${JSON.stringify(expertise, null, 2)}`

  const result = await callGemini<{
    standing_questions: Array<{ question: string; question_type: string; priority: number; trigger_description: string }>
    gaps: Array<{ gap_type: string; topic: string; description: string; severity: string; content_suggestion: string }>
    resolved_gap_topics: string[]
  }>(systemPrompt, userContent, 120000)

  if (result.standing_questions?.length > 0) {
    const qRows: Array<Record<string, unknown>> = []
    for (const q of result.standing_questions) {
      const emb = await generateEmbedding(q.question)
      qRows.push({
        user_id: agent.user_id,
        agent_id: agent.id,
        question: q.question,
        question_type: q.question_type,
        priority: q.priority,
        trigger_description: q.trigger_description,
        status: 'open',
        generated_at: new Date().toISOString(),
        embedding: emb.length > 0 ? JSON.stringify(emb) : null,
      })
    }
    await supabase.from('agent_standing_questions').insert(qRows)
  }

  if (result.resolved_gap_topics?.length > 0 && existingGaps && existingGaps.length > 0) {
    const gapIds = (existingGaps as Array<{ id: string }>).map((g) => g.id)
    await supabase
      .from('agent_gaps')
      .update({ status: 'resolved', updated_at: new Date().toISOString() })
      .in('id', gapIds)
  }

  if (result.gaps?.length > 0) {
    const gRows = result.gaps.map((g) => ({
      user_id: agent.user_id,
      agent_id: agent.id,
      gap_type: g.gap_type,
      topic: g.topic,
      description: g.description,
      severity: g.severity,
      content_suggestion: g.content_suggestion,
      status: 'active',
    }))
    await supabase.from('agent_gaps').insert(gRows)
  }
}

// ─── STEP 3: awareness register (only for THIS agent, not all siblings) ─────

async function refreshAwareness(supabase: SupabaseClient, agent: Agent): Promise<void> {
  const expertise = agent.expertise_index as ExpertiseIndex
  if (!expertise?.summary) return

  const { data: siblingsRaw } = await supabase
    .from('domain_agents')
    .select('id, name, expertise_index')
    .eq('user_id', agent.user_id)
    .neq('id', agent.id)
    .not('expertise_index', 'eq', '{}')

  const siblings = ((siblingsRaw ?? []) as Array<{ id: string; name: string; expertise_index: ExpertiseIndex | Record<string, never> }>)
    .map((s) => {
      const exp = s.expertise_index as ExpertiseIndex
      return { id: s.id, name: s.name, summary: exp?.summary ?? '', core_themes: exp?.core_themes ?? [] }
    })
    .filter((s) => s.summary)

  if (siblings.length === 0) {
    // Nothing to be aware of yet — leave awareness_register empty.
    await supabase
      .from('domain_agents')
      .update({ awareness_register: [], updated_at: new Date().toISOString() })
      .eq('id', agent.id)
    return
  }

  const systemPrompt = `You are an AI that generates an awareness register for a domain-specific advisor.
This advisor needs to know what its sibling advisors cover, so it can recognise when content might be relevant to another domain.

Output JSON:
{
  "awareness": [
    { "sibling_agent_id": "uuid", "sibling_name": "string", "relevance_summary": "1-2 sentences", "watch_topics": ["topics"] }
  ]
}`

  const userContent = `This advisor: ${agent.name}
Summary: ${expertise.summary}
Themes: ${(expertise.core_themes ?? []).join(', ')}

Sibling advisors:
${siblings.map((s) => `- ${s.name} (ID: ${s.id})\n  Themes: ${s.core_themes.slice(0, 5).join(', ')}`).join('\n')}`

  const result = await callGemini<{
    awareness: Array<{
      sibling_agent_id: string
      sibling_name: string
      relevance_summary: string
      watch_topics: string[]
    }>
  }>(systemPrompt, userContent, 120000)

  await supabase
    .from('domain_agents')
    .update({ awareness_register: result.awareness, updated_at: new Date().toISOString() })
    .eq('id', agent.id)
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!authorised(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabase = getSupabase()

  const body = (req.body ?? {}) as { agent_id?: string; next_stale?: boolean }
  let targetAgentId = body.agent_id

  if (!targetAgentId && body.next_stale) {
    const { data: next } = await supabase
      .from('domain_agents')
      .select('id')
      .eq('index_stale', true)
      .gt('source_count', 0)
      .order('source_count', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!next) {
      res.status(200).json({ ok: true, done: true, message: 'No stale agents remaining' })
      return
    }
    targetAgentId = (next as { id: string }).id
  }

  if (!targetAgentId) {
    res.status(400).json({ error: 'Missing agent_id or next_stale flag' })
    return
  }

  const { data: agentRow, error: agErr } = await supabase
    .from('domain_agents')
    .select('id, user_id, name, description, expertise_index')
    .eq('id', targetAgentId)
    .maybeSingle()

  if (agErr || !agentRow) {
    res.status(404).json({ error: `Agent not found: ${targetAgentId}` })
    return
  }

  const agent = agentRow as Agent
  const steps: Record<string, { ok: boolean; detail: string; ms: number }> = {}
  let finalStatus: 'ok' | 'no_sources' | 'failed' = 'ok'

  // Step 1
  const s1Start = Date.now()
  try {
    const r = await rebuildExpertise(supabase, agent)
    steps.expertise = { ok: true, detail: r, ms: Date.now() - s1Start }
    if (r === 'no_sources') finalStatus = 'no_sources'
  } catch (err) {
    steps.expertise = { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - s1Start }
    finalStatus = 'failed'
    res.status(200).json({ status: finalStatus, agent_id: agent.id, agent_name: agent.name, steps })
    return
  }

  if (finalStatus === 'no_sources') {
    res.status(200).json({ status: finalStatus, agent_id: agent.id, agent_name: agent.name, steps })
    return
  }

  // Step 2
  const s2Start = Date.now()
  try {
    await regenerateQuestionsAndGaps(supabase, agent)
    steps.questions_gaps = { ok: true, detail: 'ok', ms: Date.now() - s2Start }
  } catch (err) {
    steps.questions_gaps = { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - s2Start }
  }

  // Step 3
  const s3Start = Date.now()
  try {
    await refreshAwareness(supabase, agent)
    steps.awareness = { ok: true, detail: 'ok', ms: Date.now() - s3Start }
  } catch (err) {
    steps.awareness = { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - s3Start }
  }

  res.status(200).json({ status: finalStatus, agent_id: agent.id, agent_name: agent.name, steps })
}
