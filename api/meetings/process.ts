import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 120s on Vercel Pro (heavy Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ITEMS_PER_BATCH = 2;
const MAX_CONTENT_CHARS = 100_000;
const GEMINI_MAX_RETRIES = 3;

async function fetchWithRetry(url: string, options: RequestInit, retries = GEMINI_MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      console.log(`[meetings/process] Gemini 429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return response;
  }
  throw new Error('Gemini request failed after retries');
}

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface MeetingSource {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
}

interface UserProfile {
  professional_context?: {
    role?: string;
    current_projects?: string;
  };
  personal_interests?: {
    topics?: string;
  };
  processing_preferences?: {
    insight_depth?: string;
  };
}

interface ExtractionResult {
  entities: Array<{
    label: string;
    entity_type: string;
    description: string;
    confidence: number;
    tags: string[];
  }>;
  relationships: Array<{
    source: string;
    target: string;
    relation_type: string;
    evidence: string;
  }>;
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

// ─── EXTRACTION PIPELINE ───────────────────────────────────────────────────────

const ENTITY_TYPES = [
  'Person', 'Organization', 'Team', 'Topic', 'Project', 'Goal', 'Action',
  'Risk', 'Blocker', 'Decision', 'Insight', 'Question', 'Idea', 'Concept',
  'Takeaway', 'Lesson', 'Document', 'Event', 'Location', 'Technology',
  'Product', 'Metric', 'Hypothesis', 'Anchor',
];

const RELATIONSHIP_TYPES = [
  'leads_to', 'supports', 'enables', 'created', 'achieved', 'produced',
  'blocks', 'contradicts', 'risks', 'prevents', 'challenges', 'inhibits',
  'part_of', 'relates_to', 'mentions', 'connected_to', 'owns', 'associated_with',
];

const MODE_INSTRUCTIONS: Record<string, string> = {
  comprehensive: 'Extract the maximum number of meaningful entities and all significant relationships. Capture every person, organization, concept, decision, and insight mentioned.',
  strategic: 'Focus on high-level concepts, strategic decisions, goals, and their interdependencies. Prioritize organizational and directional information.',
  actionable: 'Emphasize actions, goals, blockers, deadlines, and decisions. Capture what needs to be done, by whom, and any impediments.',
  relational: 'Prioritize connections and relationships between entities. Emphasize how concepts, people, and organizations relate to each other.',
};

const EMPHASIS_INSTRUCTIONS: Record<string, string> = {
  passive: 'Treat anchors as low-priority context. Extract them if naturally occurring but do not force anchor-related entities.',
  standard: 'Give moderate weight to anchor-related content. When content relates to anchors, prioritize extracting those entities and relationships.',
  aggressive: 'Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.',
};

function buildExtractionPrompt(config: {
  mode: string;
  anchorEmphasis: string;
  anchors: Array<{ label: string; entity_type: string; description: string }>;
  userProfile: UserProfile | null;
  customInstructions?: string | null;
}): string {
  const modeInstruction = MODE_INSTRUCTIONS[config.mode] ?? MODE_INSTRUCTIONS['comprehensive']!;
  const emphasisInstruction = EMPHASIS_INSTRUCTIONS[config.anchorEmphasis] ?? EMPHASIS_INSTRUCTIONS['standard']!;

  let prompt = `You are a knowledge extraction system. Extract structured knowledge from the provided meeting content.

## Extraction Mode: ${config.mode}
${modeInstruction}

## Entity Types (use exactly these):
${ENTITY_TYPES.join(', ')}

## Relationship Types (use exactly these):
${RELATIONSHIP_TYPES.join(', ')}

## Output Format (JSON only):
{
  "entities": [
    {
      "label": "Entity name (concise, specific)",
      "entity_type": "One of the entity types above",
      "description": "1-3 sentence description",
      "confidence": 0.0-1.0,
      "tags": ["relevant", "tags"]
    }
  ],
  "relationships": [
    {
      "source": "Entity label (must match an entity above)",
      "target": "Entity label (must match an entity above)",
      "relation_type": "One of the relationship types above",
      "evidence": "Brief quote or paraphrase from content"
    }
  ]
}`;

  if (config.userProfile) {
    const role = config.userProfile.professional_context?.role;
    const projects = config.userProfile.professional_context?.current_projects;
    const interests = config.userProfile.personal_interests?.topics;
    if (role || projects || interests) {
      prompt += '\n\n## User Context (bias extraction toward relevance to this person):\n';
      if (role) prompt += `- Role: ${role}\n`;
      if (projects) prompt += `- Current projects: ${projects}\n`;
      if (interests) prompt += `- Interests: ${interests}\n`;
    }
  }

  if (config.anchors.length > 0) {
    prompt += `\n\n## Anchor Context (${emphasisInstruction}):\n`;
    for (const anchor of config.anchors.slice(0, 10)) {
      prompt += `- ${anchor.label} (${anchor.entity_type}): ${anchor.description}\n`;
    }
  }

  if (config.customInstructions) {
    prompt += `\n\n## Additional Instructions:\n${config.customInstructions}`;
  }

  prompt += '\n\nExtract knowledge from the following meeting content. Return ONLY valid JSON matching the schema above.';

  return prompt;
}

async function extractEntities(
  content: string,
  systemPrompt: string
): Promise<ExtractionResult> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_CONTENT_CHARS) }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini extraction failed: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No extraction response from Gemini');

  try {
    return JSON.parse(text) as ExtractionResult;
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 200)}`);
  }
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
    }
  );

  if (!response.ok) return [];

  const data = await response.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

function chunkText(text: string, targetTokens: number = 500): string[] {
  const targetChars = targetTokens * 4;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > targetChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 50);
}

// ─── PROCESS A SINGLE MEETING ─────────────────────────────────────────────────

async function processMeeting(
  meeting: MeetingSource,
  supabase: ReturnType<typeof getSupabase>
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...(meeting.metadata ?? {}), extraction_status: status, ...extra };
    await supabase
      .from('knowledge_sources')
      .update({ metadata: meta })
      .eq('id', meeting.id);
  };

  try {
    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    const content = meeting.content;
    if (!content || content.trim().length < 50) {
      throw new Error('Meeting content too short for extraction');
    }

    // ── STEP 1: FETCH EXTRACTION CONFIG ─────────────────────────────────────────
    const [profileResult, anchorsResult, settingsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', meeting.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', meeting.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', meeting.user_id).maybeSingle(),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Array<{ label: string; entity_type: string; description: string }>;
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;

    const extractionMode = defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = defaultSettings?.default_anchor_emphasis ?? 'standard';

    // ── STEP 2: GEMINI EXTRACTION ───────────────────────────────────────────────
    const systemPrompt = buildExtractionPrompt({
      mode: extractionMode,
      anchorEmphasis,
      anchors,
      userProfile,
    });

    const extraction = await extractEntities(content, systemPrompt);
    const { entities = [], relationships = [] } = extraction;
    console.log(`[meetings/process] Meeting ${meeting.id}: extracted ${entities.length} entities, ${relationships.length} relationships`);

    // ── STEP 3: SAVE NODES ──────────────────────────────────────────────────────
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;

      const nodePayload: Record<string, unknown> = {
        user_id: meeting.user_id,
        label: entity.label,
        entity_type: entity.entity_type,
        description: entity.description ?? null,
        confidence: entity.confidence ?? 0.8,
        source: meeting.title ?? 'Meeting',
        source_type: 'Meeting',
        source_id: meeting.id,
        tags: entity.tags ?? [],
      };

      const { data: nodeData, error: nodeError } = await supabase
        .from('knowledge_nodes')
        .insert(nodePayload)
        .select('id')
        .single();

      if (nodeError) {
        const { data: existing } = await supabase
          .from('knowledge_nodes')
          .select('id')
          .eq('user_id', meeting.user_id)
          .eq('label', entity.label)
          .maybeSingle();
        if (existing) savedNodeMap.set(entity.label, (existing as { id: string }).id);
        continue;
      }

      if (nodeData) {
        const nodeId = (nodeData as { id: string }).id;
        savedNodeMap.set(entity.label, nodeId);
        nodesCreated++;
      }
    }

    // ── STEP 4: GENERATE EMBEDDINGS ─────────────────────────────────────────────
    const nodeEmbeddings = new Map<string, number[]>();
    const embeddingTasks = [...savedNodeMap.entries()]
      .map(([label, nodeId]) => {
        const entity = entities.find(e => e.label === label);
        return entity ? { label, nodeId, entity } : null;
      })
      .filter((t): t is { label: string; nodeId: string; entity: (typeof entities)[0] } => t !== null);

    const EMBEDDING_CONCURRENCY = 5;
    for (let i = 0; i < embeddingTasks.length; i += EMBEDDING_CONCURRENCY) {
      const batch = embeddingTasks.slice(i, i + EMBEDDING_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async ({ label, nodeId, entity }) => {
          const embeddingText = `${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`;
          try {
            const embedding = await generateEmbedding(embeddingText);
            if (embedding.length > 0) {
              nodeEmbeddings.set(nodeId, embedding);
              await supabase
                .from('knowledge_nodes')
                .update({ embedding })
                .eq('id', nodeId);
            }
          } catch (err) {
            console.warn(`[meetings/process] Embedding failed for node ${label}:`, err);
          }
        })
      );
    }

    // ── STEP 5: SAVE EDGES ──────────────────────────────────────────────────────
    let edgesCreated = 0;

    for (const rel of relationships) {
      const sourceNodeId = savedNodeMap.get(rel.source);
      const targetNodeId = savedNodeMap.get(rel.target);

      if (!sourceNodeId || !targetNodeId) continue;
      if (sourceNodeId === targetNodeId) continue;

      const { error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert({
          user_id: meeting.user_id,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight: 1.0,
        });

      if (!edgeError) edgesCreated++;
    }

    // ── STEP 6: CHUNK + EMBED SOURCE ────────────────────────────────────────────
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        const embedding = await generateEmbedding(chunk);
        await supabase.from('source_chunks').insert({
          user_id: meeting.user_id,
          source_id: meeting.id,
          chunk_index: i,
          content: chunk,
          embedding: embedding.length > 0 ? embedding : null,
        });
      } catch (err) {
        console.warn(`[meetings/process] Chunk ${i} failed:`, err);
      }
    }

    // ── STEP 7: CROSS-CONNECTION DISCOVERY ──────────────────────────────────────
    if (savedNodeMap.size > 0) {
      try {
        const newNodeIds = new Set(savedNodeMap.values());
        type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null };
        const candidateMap = new Map<string, SemanticCandidate>();

        for (const [_nodeId, embedding] of nodeEmbeddings) {
          const { data: similar } = await supabase.rpc('match_knowledge_nodes', {
            query_embedding: embedding,
            match_threshold: 0.55,
            match_count: 30,
            p_user_id: meeting.user_id,
          });
          for (const s of similar ?? []) {
            if (!newNodeIds.has(s.id)) {
              candidateMap.set(s.id, s as SemanticCandidate);
            }
          }
        }

        const existingNodes = [...candidateMap.values()].slice(0, 40);

        if (existingNodes.length > 0) {
          const newEntityLines = entities.slice(0, 20)
            .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');
          const existingEntityLines = existingNodes
            .map((e) => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');

          const crossPrompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

NEW entities (just extracted from a meeting transcript):
${newEntityLines}

EXISTING entities (already in the user's knowledge graph):
${existingEntityLines}

Rules:
- Only return connections where a meaningful, non-trivial relationship exists.
- Do NOT connect entities simply because they share a label or topic — the relationship must add knowledge.
- Prefer directional types (leads_to, enables, supports, blocks) over generic types (relates_to).
- Skip connections between entities that appear to be the same concept.

Return ONLY valid JSON:
{
  "relationships": [
    { "source": "new entity label", "target": "existing entity label", "relation_type": "one of: leads_to|supports|enables|blocks|contradicts|part_of|relates_to|associated_with", "evidence": "one sentence justification" }
  ]
}

Return an empty array if no genuine cross-source connections exist.`;

          const crossResponse = await fetchWithRetry(
            `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: crossPrompt }] }],
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
              }),
              signal: AbortSignal.timeout(30000),
            }
          );

          if (crossResponse.ok) {
            const crossData = await crossResponse.json() as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const crossText = crossData.candidates?.[0]?.content?.parts?.[0]?.text;

            if (crossText) {
              try {
                const crossResult = JSON.parse(crossText) as {
                  relationships?: Array<{ source: string; target: string; relation_type: string; evidence: string }>;
                };

                const existingNodeMap = new Map(
                  existingNodes.map(n => [n.label.toLowerCase(), n.id])
                );

                for (const rel of crossResult.relationships ?? []) {
                  const srcId = savedNodeMap.get(rel.source) ?? existingNodeMap.get(rel.source?.toLowerCase());
                  const tgtId = savedNodeMap.get(rel.target) ?? existingNodeMap.get(rel.target?.toLowerCase());

                  if (srcId && tgtId && srcId !== tgtId) {
                    await supabase.from('knowledge_edges').insert({
                      user_id: meeting.user_id,
                      source_node_id: srcId,
                      target_node_id: tgtId,
                      relation_type: rel.relation_type ?? 'relates_to',
                      evidence: rel.evidence ?? null,
                      weight: 0.8,
                    });
                    edgesCreated++;
                  }
                }
              } catch { /* ignore cross-connection parse errors */ }
            }
          }
        }
      } catch (err) {
        console.warn('[meetings/process] Cross-connection discovery failed:', err);
      }
    }

    // ── COMPLETE ────────────────────────────────────────────────────────────────
    await updateStatus('completed');

    // Save extraction session record
    await supabase.from('extraction_sessions').insert({
      user_id: meeting.user_id,
      source_name: meeting.title ?? 'Meeting',
      source_type: 'Meeting',
      source_content_preview: content.slice(0, 300),
      extraction_mode: extractionMode,
      anchor_emphasis: anchorEmphasis,
      entity_count: nodesCreated,
      relationship_count: edgesCreated,
      extraction_duration_ms: null,
    });

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[meetings/process] Meeting ${meeting.id} failed:`, err);

    await updateStatus('failed');

    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const { userId, isCron } = await verifyUserAuth(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    // ── STUCK ITEM RECOVERY ────────────────────────────────────────────────────
    // Reset meetings stuck in 'processing' for >5 minutes back to 'pending'
    // (mirrors YouTube pipeline stuck-item detection)
    {
      const { data: stuckCandidates } = await supabase
        .from('knowledge_sources')
        .select('id, metadata')
        .eq('source_type', 'Meeting')
        .contains('metadata', { extraction_status: 'processing' })
        .limit(20);

      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const stuckItems = (stuckCandidates ?? []).filter(item => {
        const meta = (item as { metadata: Record<string, unknown> | null }).metadata;
        const startedAt = meta?.processing_started_at as string | undefined;
        // If no timestamp, treat as stuck (legacy item)
        if (!startedAt) return true;
        return new Date(startedAt).getTime() < fiveMinAgo;
      });

      if (stuckItems.length > 0) {
        console.log(`[meetings/process] Resetting ${stuckItems.length} stuck meetings back to pending`);
        for (const stuck of stuckItems) {
          const meta = {
            ...((stuck as { metadata: Record<string, unknown> }).metadata ?? {}),
            extraction_status: 'pending',
            last_stuck_reset: new Date().toISOString(),
          };
          await supabase
            .from('knowledge_sources')
            .update({ metadata: meta })
            .eq('id', stuck.id);
        }
      }
    }

    // Find meeting sources with extraction_status = 'pending'
    let query = supabase
      .from('knowledge_sources')
      .select('id, user_id, title, content, metadata')
      .eq('source_type', 'Meeting')
      .contains('metadata', { extraction_status: 'pending' })
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: meetings, error: fetchError } = await query;

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!meetings || meetings.length === 0) {
      return res.status(200).json({
        success: true,
        processed: 0,
        results: [],
        duration_ms: Date.now() - startTime,
      });
    }

    const results: Array<{
      id: string;
      title: string;
      status: string;
      error?: string;
      nodes_created?: number;
      edges_created?: number;
    }> = [];

    for (const raw of meetings) {
      const meeting = raw as MeetingSource;
      console.log(`[meetings/process] Processing meeting "${meeting.title}" (${meeting.id})`);

      const result = await processMeeting(meeting, supabase);

      results.push({
        id: meeting.id,
        title: meeting.title ?? 'Meeting',
        status: result.success ? 'completed' : 'failed',
        error: result.error,
        nodes_created: result.nodesCreated,
        edges_created: result.edgesCreated,
      });
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[meetings/process] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
