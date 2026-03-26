import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ITEMS_PER_BATCH = 2;
const MAX_TRANSCRIPT_CHARS = 100_000;
const EMBEDDING_CONCURRENCY = 5;
const TIME_BUDGET_MS = 50_000; // Skip cross-connections if past this

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  channel_id: string | null;
  video_id: string;
  video_title: string | null;
  video_url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  transcript: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  extraction_mode?: string;
  anchor_emphasis?: string;
  linked_anchor_ids?: string[];
  custom_instructions?: string | null;
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

  let prompt = `You are a knowledge extraction system. Extract structured knowledge from the provided content.

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

  prompt += '\n\nExtract knowledge from the following content. Return ONLY valid JSON matching the schema above.';

  return prompt;
}

async function extractEntities(
  content: string,
  systemPrompt: string
): Promise<ExtractionResult> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_TRANSCRIPT_CHARS) }] }],
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
    if (response.status === 429) {
      throw new Error(`RATE_LIMITED: Gemini rate limit hit`);
    }
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

// ─── DAILY LIMIT CHECK ─────────────────────────────────────────────────────────

async function checkDailyLimit(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const { data: settings } = await supabase
      .from('youtube_settings')
      .select('daily_video_limit, videos_ingested_today, daily_limit_reset_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (!settings) return { allowed: true, remaining: 20 };

    const s = settings as {
      daily_video_limit: number;
      videos_ingested_today: number;
      daily_limit_reset_at: string | null;
    };

    const resetAt = s.daily_limit_reset_at ? new Date(s.daily_limit_reset_at) : null;
    if (resetAt && resetAt < new Date()) {
      await supabase
        .from('youtube_settings')
        .update({
          videos_ingested_today: 0,
          daily_limit_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .eq('user_id', userId);
      return { allowed: true, remaining: s.daily_video_limit ?? 20 };
    }

    const limit = s.daily_video_limit ?? 20;
    const ingested = s.videos_ingested_today ?? 0;
    return { allowed: ingested < limit, remaining: limit - ingested };
  } catch {
    return { allowed: true, remaining: 20 };
  }
}

// ─── MAIN EXTRACTION LOGIC ─────────────────────────────────────────────────────

async function extractKnowledgeForItem(
  item: QueueItem,
  supabase: ReturnType<typeof getSupabase>,
  itemStartTime: number
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const transcript = item.transcript;

  try {
    // ── Mark as extracting ──────────────────────────────────────────────────────
    await supabase
      .from('youtube_ingestion_queue')
      .update({ status: 'extracting', started_at: new Date().toISOString() })
      .eq('id', item.id);

    // ── STEP 1: SAVE SOURCE ─────────────────────────────────────────────────────
    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: item.user_id,
        title: item.video_title ?? `YouTube: ${item.video_id}`,
        source_type: 'YouTube',
        source_url: item.video_url,
        content: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
        metadata: {
          video_id: item.video_id,
          duration_seconds: item.duration_seconds,
          published_at: item.published_at,
          transcript_source: 'decoupled_pipeline',
        },
      })
      .select('id')
      .single();

    if (sourceError || !sourceData) {
      throw new Error(`Failed to save source: ${sourceError?.message}`);
    }
    const sourceId = sourceData.id as string;

    await supabase
      .from('youtube_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // ── STEP 2: FETCH EXTRACTION CONFIG ─────────────────────────────────────────
    const [profileResult, anchorsResult, settingsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', item.user_id)
        .eq('is_anchor', true)
        .limit(10),
      supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', item.user_id).maybeSingle(),
    ]);

    const userProfile = profileResult.data as UserProfile | null;
    const anchors = (anchorsResult.data ?? []) as Array<{ label: string; entity_type: string; description: string }>;
    const defaultSettings = settingsResult.data as { default_mode: string; default_anchor_emphasis: string } | null;

    const extractionMode = item.extraction_mode ?? defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = item.anchor_emphasis ?? defaultSettings?.default_anchor_emphasis ?? 'standard';

    // ── STEP 3: GEMINI EXTRACTION ───────────────────────────────────────────────
    const systemPrompt = buildExtractionPrompt({
      mode: extractionMode,
      anchorEmphasis,
      anchors,
      userProfile,
      customInstructions: item.custom_instructions,
    });

    const extraction = await extractEntities(transcript, systemPrompt);
    const { entities = [], relationships = [] } = extraction;
    console.log(`[extract-knowledge] Extracted ${entities.length} entities, ${relationships.length} relationships for ${item.video_id}`);

    // ── STEP 4: SAVE NODES ──────────────────────────────────────────────────────
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;

      const nodePayload: Record<string, unknown> = {
        user_id: item.user_id,
        label: entity.label,
        entity_type: entity.entity_type,
        description: entity.description ?? null,
        confidence: entity.confidence ?? 0.8,
        source: item.video_title ?? item.video_id,
        source_type: 'YouTube',
        source_url: item.video_url,
        source_id: sourceId,
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
          .eq('user_id', item.user_id)
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

    // ── STEP 5: GENERATE EMBEDDINGS ─────────────────────────────────────────────
    const nodeEmbeddings = new Map<string, number[]>();
    const embeddingTasks = [...savedNodeMap.entries()]
      .map(([label, nodeId]) => {
        const entity = entities.find(e => e.label === label);
        return entity ? { label, nodeId, entity } : null;
      })
      .filter((t): t is { label: string; nodeId: string; entity: (typeof entities)[0] } => t !== null);

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
            console.warn(`[extract-knowledge] Embedding failed for node ${label}:`, err);
          }
        })
      );
    }

    // ── STEP 6: SAVE EDGES ──────────────────────────────────────────────────────
    let edgesCreated = 0;
    let crossConnectionCount = 0;

    for (const rel of relationships) {
      const sourceNodeId = savedNodeMap.get(rel.source);
      const targetNodeId = savedNodeMap.get(rel.target);

      if (!sourceNodeId || !targetNodeId) continue;
      if (sourceNodeId === targetNodeId) continue;

      const { error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert({
          user_id: item.user_id,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight: 1.0,
        });

      if (!edgeError) edgesCreated++;
    }

    // ── STEP 7: CHUNK + EMBED SOURCE ────────────────────────────────────────────
    const chunks = chunkText(transcript);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        const embedding = await generateEmbedding(chunk);
        await supabase.from('knowledge_source_chunks').insert({
          user_id: item.user_id,
          source_id: sourceId,
          chunk_index: i,
          content: chunk,
          embedding: embedding.length > 0 ? embedding : null,
        });
      } catch (err) {
        console.warn(`[extract-knowledge] Chunk ${i} failed:`, err);
      }
    }

    // ── STEP 8: CROSS-CONNECTION DISCOVERY ──────────────────────────────────────
    const elapsed = Date.now() - itemStartTime;
    if (savedNodeMap.size > 0 && elapsed < TIME_BUDGET_MS) {
      try {
        const newNodeIds = new Set(savedNodeMap.values());

        type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null };
        const candidateMap = new Map<string, SemanticCandidate>();

        for (const [_nodeId, embedding] of nodeEmbeddings) {
          const { data: similar } = await supabase.rpc('match_knowledge_nodes', {
            query_embedding: embedding,
            match_threshold: 0.55,
            match_count: 30,
            p_user_id: item.user_id,
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

NEW entities (just ingested from a YouTube video):
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

          const crossResponse = await fetch(
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
                  const sourceId2 = savedNodeMap.get(rel.source) ?? existingNodeMap.get(rel.source?.toLowerCase());
                  const targetId = savedNodeMap.get(rel.target) ?? existingNodeMap.get(rel.target?.toLowerCase());

                  if (sourceId2 && targetId && sourceId2 !== targetId) {
                    await supabase.from('knowledge_edges').insert({
                      user_id: item.user_id,
                      source_node_id: sourceId2,
                      target_node_id: targetId,
                      relation_type: rel.relation_type ?? 'relates_to',
                      evidence: rel.evidence ?? null,
                      weight: 0.8,
                    });
                    edgesCreated++;
                    crossConnectionCount++;
                  }
                }
              } catch { /* ignore cross-connection parse errors */ }
            }
          }
        }
      } catch (err) {
        console.warn('[extract-knowledge] Cross-connection discovery failed:', err);
      }
    } else if (elapsed >= TIME_BUDGET_MS) {
      console.log(`[extract-knowledge] Skipping cross-connections — time budget exceeded (${elapsed}ms)`);
    }

    // ── COMPLETE ────────────────────────────────────────────────────────────────
    await supabase
      .from('youtube_ingestion_queue')
      .update({
        status: 'completed',
        nodes_created: nodesCreated,
        edges_created: edgesCreated,
        completed_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    // Save extraction session record
    await supabase.from('extraction_sessions').insert({
      user_id: item.user_id,
      source_name: item.video_title ?? item.video_id,
      source_type: 'YouTube',
      source_content_preview: transcript.slice(0, 300),
      extraction_mode: extractionMode,
      anchor_emphasis: anchorEmphasis,
      user_guidance: item.custom_instructions ?? null,
      selected_anchor_ids: item.linked_anchor_ids ?? [],
      entity_count: nodesCreated,
      relationship_count: edgesCreated,
      chunk_count: chunks.length,
      cross_connection_count: crossConnectionCount,
      extraction_duration_ms: Date.now() - itemStartTime,
    });

    // Update daily counter
    try {
      const { data: ys } = await supabase
        .from('youtube_settings')
        .select('videos_ingested_today')
        .eq('user_id', item.user_id)
        .maybeSingle();
      if (ys) {
        await supabase
          .from('youtube_settings')
          .update({ videos_ingested_today: ((ys as { videos_ingested_today: number }).videos_ingested_today ?? 0) + 1 })
          .eq('user_id', item.user_id);
      }
    } catch { /* ignore */ }

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract-knowledge] Item ${item.id} failed:`, err);

    const isRateLimited = msg.startsWith('RATE_LIMITED');
    const newRetryCount = (item.retry_count ?? 0) + 1;
    const maxRetries = item.max_retries ?? 3;

    if (isRateLimited || newRetryCount < maxRetries) {
      // Re-queue to transcript_ready for retry (transcript is preserved)
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: 'transcript_ready',
          retry_count: newRetryCount,
          error_message: msg,
          started_at: null,
        })
        .eq('id', item.id);
    } else {
      await supabase
        .from('youtube_ingestion_queue')
        .update({
          status: 'failed',
          retry_count: newRetryCount,
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
    }

    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const { userId, isCron } = await verifyUserAuth(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    // ── Stuck item cleanup ─────────────────────────────────────────────────────
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase
      .from('youtube_ingestion_queue')
      .update({ status: 'transcript_ready', error_message: 'Reset: stuck in extracting', started_at: null })
      .eq('status', 'extracting')
      .lt('started_at', fiveMinAgo);

    // ── Pick items with transcripts ready for extraction ───────────────────────
    let query = supabase
      .from('youtube_ingestion_queue')
      .select(`
        id, user_id, channel_id, video_id, video_title, video_url,
        thumbnail_url, published_at, duration_seconds, transcript, status,
        retry_count, max_retries, error_message, playlist_id,
        youtube_playlists (
          extraction_mode,
          anchor_emphasis,
          linked_anchor_ids,
          custom_instructions
        )
      `)
      .eq('status', 'transcript_ready')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: pendingItems, error: fetchError } = await query;

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (!pendingItems || pendingItems.length === 0) {
      return res.status(200).json({
        success: true,
        processed: 0,
        results: [],
        message: 'No items ready for extraction',
        duration_ms: Date.now() - startTime,
      });
    }

    // Flatten joined playlist settings
    const items: QueueItem[] = (pendingItems as Array<Record<string, unknown>>).map(row => {
      const playlist = row['youtube_playlists'] as Record<string, unknown> | null;
      return {
        id: row['id'] as string,
        user_id: row['user_id'] as string,
        channel_id: row['channel_id'] as string | null,
        video_id: row['video_id'] as string,
        video_title: row['video_title'] as string | null,
        video_url: row['video_url'] as string,
        thumbnail_url: row['thumbnail_url'] as string | null,
        published_at: row['published_at'] as string | null,
        duration_seconds: row['duration_seconds'] as number | null,
        transcript: row['transcript'] as string,
        status: row['status'] as string,
        retry_count: (row['retry_count'] as number) ?? 0,
        max_retries: (row['max_retries'] as number) ?? 3,
        error_message: row['error_message'] as string | null,
        extraction_mode: playlist?.['extraction_mode'] as string | undefined,
        anchor_emphasis: playlist?.['anchor_emphasis'] as string | undefined,
        linked_anchor_ids: (playlist?.['linked_anchor_ids'] as string[]) ?? [],
        custom_instructions: playlist?.['custom_instructions'] as string | null | undefined,
      };
    });

    // Check daily limits and filter
    const allowedItems: QueueItem[] = [];
    const results: Array<{
      id: string;
      status: string;
      error?: string;
      nodes_created?: number;
      edges_created?: number;
    }> = [];

    for (const item of items) {
      const { allowed } = await checkDailyLimit(item.user_id, supabase);
      if (!allowed) {
        results.push({ id: item.id, status: 'skipped', error: 'Daily limit reached' });
        continue;
      }
      allowedItems.push(item);
    }

    // Process items in parallel
    const extractionResults = await Promise.allSettled(
      allowedItems.map(item => extractKnowledgeForItem(item, supabase, Date.now()))
    );

    extractionResults.forEach((result, idx) => {
      const item = allowedItems[idx];
      if (!item) return;
      if (result.status === 'fulfilled') {
        results.push({
          id: item.id,
          status: result.value.success ? 'completed' : 'failed',
          error: result.value.error,
          nodes_created: result.value.nodesCreated,
          edges_created: result.value.edgesCreated,
        });
      } else {
        results.push({
          id: item.id,
          status: 'failed',
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    // Log scan history
    const processed = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    if (items.length > 0) {
      const firstUserId = items[0]?.user_id;
      if (firstUserId) {
        await supabase.from('youtube_scan_history').insert({
          user_id: firstUserId,
          scan_type: 'process',
          channel_name: null,
          videos_found: items.length,
          videos_added: 0,
          videos_skipped: 0,
          videos_processed: processed,
          videos_failed: failed,
          status: failed > 0 && processed === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        });
      }
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extract-knowledge] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
