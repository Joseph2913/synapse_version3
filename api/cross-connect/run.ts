// ─────────────────────────────────────────────────────────────────────────────
//  api/cross-connect/run.ts
//
//  Stage 8 — Cross-connection discovery (server-side, post-extraction job)
//
//  This endpoint is the authoritative implementation of Stage 8. It runs
//  entirely server-side so no browser credential is required, and is invoked
//  fire-and-forget by browser callers so it never blocks the extraction UX.
//
//  Algorithm:
//    1. Fetch newly-ingested nodes (with embeddings) from knowledge_nodes.
//    2. For each new node, call match_knowledge_nodes RPC to find semantically
//       similar existing nodes (HNSW halfvec index, threshold 0.55).
//    3. Collect the top GEMINI_BATCH_SIZE candidates across all new nodes,
//       sorted by descending similarity. Deduplicate by candidate node ID.
//    4. Send ONE Gemini call with all new entities + top candidates.
//    5. Parse the classified relationships, bulk-insert confirmed edges.
//
//  Failure policy (Stage 8 = Skip-with-telemetry per docs/FAILURE-POLICY.md):
//    Any failure logs via logError() with stage:'cross-connect' and returns 200.
//    The source status is never set to 'failed' or 'degraded' by this endpoint.
//
//  Time budget: CROSS_CONNECT_TIME_BUDGET_MS (25 s). If candidate gathering
//  takes longer than the budget, we stop early and run Gemini on whatever
//  candidates were collected. Budget chosen so the whole job fits within
//  Vercel Pro's 300 s function timeout even when called after a 120 s
//  extraction.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ─── Supabase env + factories ────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const INGEST_SECRET = process.env.INGEST_SECRET

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error(
    '[cross-connect/run] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY'
  )
}

function getServiceSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

function getAnonSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

// Resolves the calling user. Two auth modes are accepted:
//   1. x-ingest-secret header — used by server-to-server fire-and-forget calls
//      from extraction entry points. The trusted userId is read from the body.
//   2. Authorization: Bearer <jwt> — used by browser callers.
async function resolveAuth(req: VercelRequest): Promise<{ userId: string | null; isIngestSecret: boolean }> {
  const secret = req.headers['x-ingest-secret'] as string | undefined
  if (INGEST_SECRET && secret === INGEST_SECRET) {
    const bodyUserId = (req.body as { userId?: unknown } | null)?.userId
    return { userId: typeof bodyUserId === 'string' ? bodyUserId : null, isIngestSecret: true }
  }
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return { userId: null, isIngestSecret: false }
  const token = auth.slice(7)
  try {
    const { data: { user } } = await getAnonSupabase().auth.getUser(token)
    return { userId: user?.id ?? null, isIngestSecret: false }
  } catch {
    return { userId: null, isIngestSecret: false }
  }
}

// ─── Gemini env + helpers ────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!GEMINI_API_KEY) {
  throw new Error('[cross-connect/run] Missing env var: GEMINI_API_KEY')
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

async function geminiFetch(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  stage: string
): Promise<{ json: unknown; usage: GeminiUsage | undefined }> {
  const url = `${GEMINI_BASE}/${endpoint}?key=${GEMINI_API_KEY}`
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const json = await resp.json() as { usageMetadata?: GeminiUsage }
        const usage = json.usageMetadata
        if (usage) {
          console.log(JSON.stringify({
            stage, model: endpoint.split(':')[0],
            prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }))
        }
        return { json, usage }
      }
      const txt = await resp.text().catch(() => '')
      lastErr = new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`)
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } catch (err) {
      lastErr = err as Error
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('[gemini] request failed')
}

// ─── Structured logging ──────────────────────────────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────────

// Time budget for candidate gathering. If a single node's RPC takes too long
// we stop collecting and run Gemini on what we have. 25 s leaves margin inside
// Vercel Pro's 300 s timeout even when called right after a heavy extraction.
const CROSS_CONNECT_TIME_BUDGET_MS = 25_000

// Semantic similarity floor. Candidates below this score are discarded before
// Gemini sees them. 0.55 is consistent with the inline pipeline value.
const SIMILARITY_THRESHOLD = 0.55

// Candidates returned per-node from the RPC. Padded by nodeIds.length so new
// nodes can be filtered out before counting toward the per-node cap.
const CANDIDATES_PER_NODE = 30

// Max total candidates forwarded to Gemini in one call. Keeps the prompt
// under ~4 k tokens and the Gemini timeout at 30 s.
const GEMINI_BATCH_SIZE = 20

// ─── Input validation ────────────────────────────────────────────────────────

// Body accepts either:
//   { nodeIds: string[], sourceId?: string }            — explicit node list (legacy callers)
//   { sourceId: string, userId?: string, nodeIds?: [] } — sourceId-only mode: endpoint fetches
//                                                          all nodes for the source from the DB.
//                                                          Required for retries where the in-memory
//                                                          "new entities" handoff is empty.
interface RunBody {
  nodeIds?: string[]
  sourceId?: string
  userId?: string
}

function isRunBody(b: unknown): b is RunBody {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  const hasNodeIds = Array.isArray(o.nodeIds)
  const hasSourceId = typeof o.sourceId === 'string' && o.sourceId.length > 0
  if (!hasNodeIds && !hasSourceId) return false
  if (hasNodeIds) {
    const arr = o.nodeIds as unknown[]
    if (arr.length > 500) return false
    if (!arr.every((id) => typeof id === 'string')) return false
  }
  if (o.sourceId !== undefined && typeof o.sourceId !== 'string') return false
  if (o.userId !== undefined && typeof o.userId !== 'string') return false
  return true
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface NodeRow {
  id: string
  label: string
  entity_type: string
  description: string | null
  embedding: number[] | null
}

interface SemanticCandidate {
  id: string
  label: string
  entity_type: string
  description: string | null
  similarity: number
}

interface EdgeRow {
  user_id: string
  source_node_id: string
  target_node_id: string
  relation_type: string
  evidence: string | null
  weight: number
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const { userId, isIngestSecret } = await resolveAuth(req)
  if (!userId) {
    return res.status(401).json({ error: 'unauthenticated' })
  }

  if (!isRunBody(req.body)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'Expected { nodeIds: string[] } or { sourceId: string }' })
  }

  const { nodeIds: bodyNodeIds, sourceId } = req.body
  const startedAt = Date.now()
  const sb = getServiceSupabase()

  // Resolve which nodes to bridge from. Two modes:
  //   - Explicit nodeIds (legacy callers, browser-initiated runs)
  //   - sourceId only — fetch all nodes for that source from the DB. Used by
  //     the post-extraction fire-and-forget triggers and retries.
  let nodeIds: string[] = bodyNodeIds ?? []
  if (nodeIds.length === 0 && sourceId) {
    const { data: sourceNodes, error: sourceErr } = await sb
      .from('knowledge_nodes')
      .select('id')
      .eq('source_id', sourceId)
      .eq('user_id', userId)
      .limit(500)
    if (sourceErr) {
      logError({ stage: 'cross-connect', user_id: userId, source_id: sourceId, status: 'skipped', error: `source-node lookup failed: ${sourceErr.message}`, duration_ms: Date.now() - startedAt })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }
    nodeIds = (sourceNodes ?? []).map(n => (n as { id: string }).id)
  }

  if (nodeIds.length === 0) {
    log({ stage: 'cross-connect', status: 'skipped', user_id: userId, source_id: sourceId, reason: 'no_nodes_for_source', duration_ms: Date.now() - startedAt })
    return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
  }

  log({ stage: 'cross-connect', status: 'ok', user_id: userId, source_id: sourceId, node_count: nodeIds.length, auth: isIngestSecret ? 'ingest_secret' : 'jwt' })

  try {
    // ── 1. Fetch the source's nodes with embeddings ──────────────────────────
    const { data: newNodesRaw, error: fetchErr } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description, embedding')
      .in('id', nodeIds)
      .eq('user_id', userId)

    if (fetchErr || !newNodesRaw?.length) {
      logError({
        stage: 'cross-connect',
        user_id: userId,
        source_id: sourceId,
        status: 'skipped',
        error: fetchErr?.message ?? 'no nodes found',
        duration_ms: Date.now() - startedAt,
      })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    const newNodes = newNodesRaw as NodeRow[]
    const newNodeIdSet = new Set(nodeIds)

    // ── 2. Gather candidates via match_knowledge_nodes RPC ───────────────────
    // One RPC call per new node. Candidates are deduplicated into a map keyed
    // by candidate ID, keeping the highest similarity score seen across nodes.
    // We stop early if the time budget is consumed during candidate gathering.
    const candidateMap = new Map<string, SemanticCandidate>()

    for (const node of newNodes) {
      if (!node.embedding) continue
      if (Date.now() - startedAt >= CROSS_CONNECT_TIME_BUDGET_MS) {
        log({ stage: 'cross-connect', status: 'partial', user_id: userId, source_id: sourceId, reason: 'time_budget_during_rpc' })
        break
      }

      const { data: similar, error: rpcErr } = await sb.rpc('match_knowledge_nodes', {
        query_embedding: node.embedding,
        match_threshold: SIMILARITY_THRESHOLD,
        match_count: CANDIDATES_PER_NODE + nodeIds.length,
        p_user_id: userId,
      })

      if (rpcErr) {
        logError({ stage: 'cross-connect', user_id: userId, source_id: sourceId, status: 'skipped', error: `RPC error: ${rpcErr.message}` })
        continue
      }

      for (const s of (similar ?? []) as SemanticCandidate[]) {
        if (newNodeIdSet.has(s.id)) continue
        const existing = candidateMap.get(s.id)
        if (!existing || s.similarity > existing.similarity) {
          candidateMap.set(s.id, s)
        }
      }
    }

    // Sort descending by similarity, cap at GEMINI_BATCH_SIZE
    const topCandidates = [...candidateMap.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, GEMINI_BATCH_SIZE)

    if (topCandidates.length === 0) {
      log({ stage: 'cross-connect', status: 'ok', user_id: userId, source_id: sourceId, duration_ms: Date.now() - startedAt, edges_created: 0, reason: 'no_candidates' })
      return res.status(200).json({ edgesCreated: 0, status: 'ok' })
    }

    // Check budget before the Gemini call
    if (Date.now() - startedAt >= CROSS_CONNECT_TIME_BUDGET_MS) {
      log({ stage: 'cross-connect', status: 'skipped', user_id: userId, source_id: sourceId, duration_ms: Date.now() - startedAt, reason: 'time_budget_before_gemini' })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    // ── 3. Single Gemini call — batch all new + candidate entities together ──
    const newList = newNodes
      .map(n => `- [${n.entity_type}] ${n.label}: ${n.description ?? 'No description'}`)
      .join('\n')
    const existingList = topCandidates
      .map(n => `- [${n.entity_type}] ${n.label}: ${n.description ?? 'No description'}`)
      .join('\n')

    const prompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

New entities (just ingested from a new source):
${newList}

Existing entities (already in the user's knowledge graph):
${existingList}

Rules:
- Only return connections where a meaningful, non-trivial relationship exists.
- Do NOT connect entities simply because they share a label or topic — the relationship must add knowledge.
- Prefer directional types (leads_to, enables, supports, blocks) over generic types (relates_to).
- Skip connections between entities that appear to be the same concept described differently.

Return ONLY valid JSON:
{
  "relationships": [
    {
      "source": "exact entity label",
      "target": "exact entity label",
      "relation_type": "one of: leads_to|supports|enables|blocks|contradicts|part_of|relates_to|associated_with",
      "evidence": "one sentence justification"
    }
  ]
}

Return an empty array if no genuine cross-source connections exist.`

    let geminiUsage: GeminiUsage | undefined
    let rawText: string
    try {
      const { json, usage } = await geminiFetch(
        `${GEMINI_MODEL}:generateContent`,
        {
          system_instruction: {
            parts: [{ text: 'You are a knowledge graph relationship expert. Find non-obvious cross-source connections between entities from different content sources. Prioritise directional, specific relationship types over generic ones.' }],
          },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        },
        30_000,
        'cross-connect'
      )
      geminiUsage = usage
      const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    } catch (geminiErr) {
      logError({ stage: 'cross-connect', user_id: userId, source_id: sourceId, status: 'skipped', error: `Gemini error: ${(geminiErr as Error).message}`, duration_ms: Date.now() - startedAt })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    if (!rawText) {
      log({ stage: 'cross-connect', status: 'skipped', user_id: userId, source_id: sourceId, duration_ms: Date.now() - startedAt, reason: 'empty_gemini_response' })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    // ── 4. Parse relationships ────────────────────────────────────────────────
    let parsed: { relationships?: Array<{ source: string; target: string; relation_type: string; evidence: string }> }
    try {
      parsed = JSON.parse(rawText) as typeof parsed
    } catch {
      logError({ stage: 'cross-connect', user_id: userId, source_id: sourceId, status: 'skipped', error: 'malformed JSON from Gemini', raw_preview: rawText.slice(0, 200), duration_ms: Date.now() - startedAt })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    if (!Array.isArray(parsed.relationships) || parsed.relationships.length === 0) {
      log({ stage: 'cross-connect', status: 'ok', user_id: userId, source_id: sourceId, duration_ms: Date.now() - startedAt, edges_created: 0, prompt_tokens: geminiUsage?.promptTokenCount })
      return res.status(200).json({ edgesCreated: 0, status: 'ok' })
    }

    // ── 5. Map labels → IDs and bulk insert confirmed edges ──────────────────
    const newLabelMap = new Map(newNodes.map(n => [n.label.toLowerCase(), n.id]))
    const existingLabelMap = new Map(topCandidates.map(n => [n.label.toLowerCase(), n.id]))
    const combinedLabelMap = new Map([...existingLabelMap, ...newLabelMap])

    const toInsert = parsed.relationships
      .map((rel): EdgeRow | null => {
        const srcId = combinedLabelMap.get(rel.source?.toLowerCase())
        const tgtId = combinedLabelMap.get(rel.target?.toLowerCase())
        if (!srcId || !tgtId || srcId === tgtId || !rel.relation_type) return null
        return {
          user_id: userId,
          source_node_id: srcId,
          target_node_id: tgtId,
          relation_type: rel.relation_type,
          evidence: rel.evidence ?? null,
          weight: 0.8,
        }
      })
      .filter((r): r is EdgeRow => r !== null)

    if (toInsert.length === 0) {
      log({ stage: 'cross-connect', status: 'ok', user_id: userId, source_id: sourceId, duration_ms: Date.now() - startedAt, edges_created: 0, prompt_tokens: geminiUsage?.promptTokenCount })
      return res.status(200).json({ edgesCreated: 0, status: 'ok' })
    }

    // One bulk insert — never loop individual inserts (CLAUDE.md bulk-write rule)
    const { data: inserted, error: insertErr } = await sb
      .from('knowledge_edges')
      .insert(toInsert)
      .select('id')

    if (insertErr) {
      logError({ stage: 'cross-connect', user_id: userId, source_id: sourceId, status: 'skipped', error: `bulk insert failed: ${insertErr.message}`, edge_count: toInsert.length, duration_ms: Date.now() - startedAt })
      return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
    }

    const edgesCreated = inserted?.length ?? 0
    log({
      stage: 'cross-connect',
      status: 'ok',
      user_id: userId,
      source_id: sourceId,
      duration_ms: Date.now() - startedAt,
      edges_created: edgesCreated,
      candidates_evaluated: topCandidates.length,
      prompt_tokens: geminiUsage?.promptTokenCount,
      output_tokens: geminiUsage?.candidatesTokenCount,
    })

    return res.status(200).json({ edgesCreated, status: 'ok' })

  } catch (err) {
    // Skip-with-telemetry: log the error, return 200 so the caller does not retry
    logError({
      stage: 'cross-connect',
      user_id: userId,
      source_id: sourceId,
      status: 'skipped',
      error: (err as Error).message,
      duration_ms: Date.now() - startedAt,
    })
    return res.status(200).json({ edgesCreated: 0, status: 'skipped' })
  }
}
