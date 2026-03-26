import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY            = process.env.GEMINI_API_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function resolveUserId(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth) return null

  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) {
    return (req.body as Record<string, unknown>)?.userId as string ?? null
  }

  const token = auth.replace('Bearer ', '')
  const sb = getSupabase()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  return user.id
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const startTime = Date.now()
  const userId = await resolveUserId(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body as { nodeId?: string; userId?: string }
  const { nodeId } = body

  if (!nodeId) {
    return res.status(400).json({ error: 'nodeId is required' })
  }

  const sb = getSupabase()

  try {
    // 1. Fetch the confirmed anchor node
    const { data: anchorNode, error: anchorErr } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description')
      .eq('id', nodeId)
      .eq('user_id', userId)
      .single()

    if (anchorErr || !anchorNode) {
      return res.status(404).json({ error: 'Anchor node not found' })
    }

    // 2. Fetch existing edges to build connected-node set
    const [outRes, inRes] = await Promise.all([
      sb.from('knowledge_edges').select('target_node_id').eq('source_node_id', nodeId).eq('user_id', userId),
      sb.from('knowledge_edges').select('source_node_id').eq('target_node_id', nodeId).eq('user_id', userId),
    ])
    const connectedIds = new Set<string>()
    connectedIds.add(nodeId) // exclude self
    for (const e of outRes.data ?? []) connectedIds.add(e.target_node_id)
    for (const e of inRes.data ?? []) connectedIds.add(e.source_node_id)

    // 3. Fetch unconnected non-anchor nodes (batched, max 200 for Gemini)
    const { data: candidateNodes } = await sb
      .from('knowledge_nodes')
      .select('id, label, entity_type, description')
      .eq('user_id', userId)
      .eq('is_anchor', false)
      .order('created_at', { ascending: false })
      .limit(500)

    const unconnected = (candidateNodes ?? [])
      .filter(n => !connectedIds.has(n.id as string))
      .slice(0, 200)

    if (unconnected.length === 0) {
      console.log(`[on-confirm] nodeId=${nodeId} — no unconnected nodes to evaluate`)
      return res.status(200).json({ success: true, edgesCreated: 0, duration_ms: Date.now() - startTime })
    }

    // 4. Build the node list string for Gemini
    const nodeList = unconnected
      .map(n => `id: ${n.id}, label: ${n.label} (${n.entity_type})`)
      .join('\n')

    const prompt = `You are analysing a knowledge graph. A new anchor node has been created:
Anchor: "${anchorNode.label}" (${anchorNode.entity_type})
Description: "${anchorNode.description ?? 'No description'}"

Below is a list of existing knowledge nodes. Identify which ones are meaningfully related to this anchor and should have a direct connection.

Return ONLY a JSON array of objects:
[{"nodeId": "...", "relationType": "relates_to|supports|part_of|leads_to|enables", "evidence": "one sentence explanation"}]

Only include nodes where the relationship is clear and meaningful. Maximum 20 results.
Omit nodes that are only tangentially related.

Nodes to evaluate:
${nodeList}`

    // 5. Call Gemini
    const geminiResponse = await fetch(
      `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(45000),
      }
    )

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text()
      console.error(`[on-confirm] Gemini error: ${geminiResponse.status} ${errText.slice(0, 200)}`)
      return res.status(200).json({ success: true, edgesCreated: 0, note: 'Gemini call failed', duration_ms: Date.now() - startTime })
    }

    const geminiData = await geminiResponse.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text
    if (!responseText) {
      return res.status(200).json({ success: true, edgesCreated: 0, note: 'No Gemini response', duration_ms: Date.now() - startTime })
    }

    // 6. Parse and insert edges
    let edgesCreated = 0
    try {
      const connections = JSON.parse(responseText) as Array<{
        nodeId: string; relationType: string; evidence: string
      }>

      const validNodeIds = new Set(unconnected.map(n => n.id as string))
      const validRelTypes = new Set([
        'leads_to', 'supports', 'enables', 'created', 'achieved', 'produced',
        'blocks', 'contradicts', 'risks', 'prevents', 'challenges', 'inhibits',
        'part_of', 'relates_to', 'mentions', 'connected_to', 'owns', 'associated_with',
      ])

      for (const conn of connections.slice(0, 20)) {
        if (!validNodeIds.has(conn.nodeId)) continue
        if (connectedIds.has(conn.nodeId)) continue
        const relType = validRelTypes.has(conn.relationType) ? conn.relationType : 'relates_to'

        const { error: edgeErr } = await sb.from('knowledge_edges').insert({
          user_id: userId,
          source_node_id: nodeId,
          target_node_id: conn.nodeId,
          relation_type: relType,
          evidence: conn.evidence ?? null,
          weight: 0.7,
        })

        if (!edgeErr) {
          edgesCreated++
          connectedIds.add(conn.nodeId) // prevent duplicates within this run
        }
      }
    } catch (parseErr) {
      console.warn('[on-confirm] Failed to parse Gemini response:', parseErr)
    }

    console.log(`[on-confirm] nodeId=${nodeId} edgesCreated=${edgesCreated} duration=${Date.now() - startTime}ms`)

    return res.status(200).json({
      success: true,
      edgesCreated,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[on-confirm] Error:', msg)
    return res.status(200).json({ success: true, edgesCreated: 0, error: msg, duration_ms: Date.now() - startTime })
  }
}
