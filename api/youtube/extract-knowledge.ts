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
  playlist_id?: string | null;
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

    // ── STEP 4: DEDUPLICATION + SAVE NODES ─────────────────────────────────────
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

    // 4A: Exact-match deduplication (case-insensitive, same entity_type)
    const entityLabels = entities.filter(e => e.label && e.entity_type).map(e => e.label);
    const { data: existingNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .eq('user_id', item.user_id)
      .eq('is_merged', false)
      .in('label', entityLabels);

    const exactMatchMap = new Map<string, string>();
    for (const existing of existingNodes ?? []) {
      const matchingEntity = entities.find(
        e => e.label.toLowerCase() === (existing.label as string).toLowerCase()
          && e.entity_type === existing.entity_type
      );
      if (matchingEntity) {
        exactMatchMap.set(matchingEntity.label.toLowerCase(), existing.id as string);
      }
    }

    for (const [labelLower, existingId] of exactMatchMap) {
      const entity = entities.find(e => e.label.toLowerCase() === labelLower);
      if (entity) savedNodeMap.set(entity.label, existingId);
    }

    // 4B: Fuzzy/semantic dedup for entities not exactly matched
    const fuzzyMergeMap = new Map<string, string>();
    const nearMatchQueue: Array<{
      entityLabel: string;
      existingNodeId: string;
      similarity: number;
      matchType: string;
    }> = [];
    const prefetchedEmbeddings = new Map<string, number[]>();
    const mergedEntitiesLog: Array<{
      original_label: string;
      merged_into_id: string;
      similarity: number;
      match_type: string;
    }> = [];

    const entitiesToDedupCheck = entities.filter(
      e => e.label && e.entity_type && !exactMatchMap.has(e.label.toLowerCase())
    );

    const DEDUP_CONCURRENCY = 3;
    for (let i = 0; i < entitiesToDedupCheck.length; i += DEDUP_CONCURRENCY) {
      const batch = entitiesToDedupCheck.slice(i, i + DEDUP_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (entity) => {
          const embeddingText = `${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`;
          try {
            const embedding = await generateEmbedding(embeddingText);
            if (embedding.length > 0) {
              prefetchedEmbeddings.set(entity.label, embedding);

              const { data: matches } = await supabase.rpc('check_node_duplicate', {
                p_user_id: item.user_id,
                p_label: entity.label,
                p_entity_type: entity.entity_type,
                p_embedding: embedding,
                p_exact_threshold: 0.92,
                p_semantic_threshold: 0.88,
              });

              const best = (matches as Array<{
                match_id: string; match_label: string; match_type: string; similarity: number;
              }> | null)?.[0];

              if (!best) return;

              if (best.match_type === 'exact' ||
                  (best.match_type === 'fuzzy' && best.similarity >= 0.95)) {
                fuzzyMergeMap.set(entity.label.toLowerCase(), best.match_id);
                mergedEntitiesLog.push({
                  original_label: entity.label,
                  merged_into_id: best.match_id,
                  similarity: best.similarity,
                  match_type: best.match_type,
                });
              } else if (best.match_type === 'fuzzy' || best.match_type === 'semantic') {
                nearMatchQueue.push({
                  entityLabel: entity.label,
                  existingNodeId: best.match_id,
                  similarity: best.similarity,
                  matchType: best.match_type,
                });
              }
            }
          } catch (err) {
            console.warn(`[extract-knowledge] Dedup check failed for "${entity.label}":`, err);
          }
        })
      );
    }

    // Pre-populate savedNodeMap with fuzzy-merged nodes
    for (const [labelLower, existingId] of fuzzyMergeMap) {
      const entity = entities.find(e => e.label.toLowerCase() === labelLower);
      if (entity) {
        savedNodeMap.set(entity.label, existingId);
        if (entity.description) {
          const { data: existNode } = await supabase
            .from('knowledge_nodes')
            .select('description')
            .eq('id', existingId)
            .maybeSingle();
          if (!existNode?.description || entity.description.length > (existNode.description as string).length) {
            await supabase.from('knowledge_nodes').update({ description: entity.description }).eq('id', existingId);
          }
        }
      }
    }

    // 4C: Insert only new nodes (not in exactMatchMap or fuzzyMergeMap)
    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;
      if (exactMatchMap.has(entity.label.toLowerCase())) continue;
      if (fuzzyMergeMap.has(entity.label.toLowerCase())) continue;

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

    // 4D: Queue near-matches for review
    for (const nm of nearMatchQueue) {
      const newNodeId = savedNodeMap.get(nm.entityLabel);
      if (!newNodeId) continue;
      try {
        await supabase.from('potential_duplicates').insert({
          user_id: item.user_id,
          node_a_id: nm.existingNodeId,
          node_b_id: newNodeId,
          similarity: nm.similarity,
          match_type: nm.matchType,
          status: 'pending',
          metadata: {
            new_label: nm.entityLabel,
            detected_at: new Date().toISOString(),
            detection_source: 'extraction_pipeline',
          },
        });
      } catch { /* ignore duplicate constraint violations */ }
    }

    console.log(`[extract-knowledge] Dedup: ${exactMatchMap.size} exact + ${fuzzyMergeMap.size} fuzzy matches reused, ${nodesCreated} new nodes, ${nearMatchQueue.length} near-matches queued for ${item.video_id}`);

    // ── STEP 5: GENERATE EMBEDDINGS (use prefetched where available) ───────────
    const nodeEmbeddings = new Map<string, number[]>();
    const embeddingTasks = [...savedNodeMap.entries()]
      .map(([label, nodeId]) => {
        const entity = entities.find(e => e.label === label);
        const isReused = exactMatchMap.has(label.toLowerCase()) || fuzzyMergeMap.has(label.toLowerCase());
        return entity && !isReused ? { label, nodeId, entity } : null;
      })
      .filter((t): t is { label: string; nodeId: string; entity: (typeof entities)[0] } => t !== null);

    for (let i = 0; i < embeddingTasks.length; i += EMBEDDING_CONCURRENCY) {
      const batch = embeddingTasks.slice(i, i + EMBEDDING_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async ({ label, nodeId, entity }) => {
          const prefetched = prefetchedEmbeddings.get(label);
          const embedding = prefetched && prefetched.length > 0
            ? prefetched
            : await generateEmbedding(`${entity.entity_type}: ${entity.label} — ${entity.description ?? ''}`);
          try {
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
        await supabase.from('source_chunks').insert({
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

    // ── TRIGGER ANCHOR SCORING (fire-and-forget) ────────────────────────────────
    // Non-fatal: if scoring fails, extraction is still considered successful.
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({
          userId:   item.user_id,
          sourceId: sourceId,
          nodeIds:  savedNodeIds,
        }),
      }).catch(err => {
        console.warn('[extract-knowledge] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── ADVISORY COUNCIL HOOK (fire-and-forget, non-fatal) ─────────────────────
    try {
      await runAdvisoryCouncilHook(item, sourceId, supabase);
    } catch (councilErr) {
      console.warn('[extract-knowledge] Advisory council hook failed (non-fatal):', councilErr);
    }

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

// ─── ADVISORY COUNCIL HOOK ────────────────────────────────────────────────────
//
// Post-extraction hook that updates the relevant domain agent whenever a
// new YouTube video is ingested.  Wrapped in try-catch — a failure here
// must NEVER cause the extraction to be marked as failed.
//
// Steps:
//   1. Resolve domain agent via playlist_id → youtube_playlists.domain_agent_id
//   2. Create source association (upsert into domain_agent_sources)
//   3. Gemini ingestion-time analysis (insights + question eval + summary)
//   4. Persist detected insights
//   5. Update standing questions
//   6. Detect cross-domain signals from edges
//   7. Flag expertise index as stale, update counters

interface AdvisoryInsight {
  type: 'tension' | 'convergence' | 'novel_connection';
  claim: string;
  evidence_summary: string;
  related_entity_labels: string[];
  confidence: number;
}

interface QuestionUpdate {
  question_id: string;
  new_status: 'partially_addressed' | 'answered';
  evidence: string;
}

interface AdvisoryAnalysisResult {
  insights: AdvisoryInsight[];
  question_updates: QuestionUpdate[];
  contribution_summary: string;
}

async function runAdvisoryCouncilHook(
  item: QueueItem,
  sourceId: string,
  supabase: ReturnType<typeof getSupabase>
): Promise<void> {
  const hookStart = Date.now();

  // ── Step 1: Resolve domain agent ──────────────────────────────────────────
  if (!item.playlist_id) return;

  const { data: playlist } = await supabase
    .from('youtube_playlists')
    .select('domain_agent_id')
    .eq('id', item.playlist_id)
    .maybeSingle();

  const agentId = (playlist as { domain_agent_id: string | null } | null)?.domain_agent_id;
  if (!agentId) return; // No domain agent — playlist predates advisory council

  console.log(`[advisory-council] Hook started for agent ${agentId}, source ${sourceId}`);

  // ── Step 2: Create source association (idempotent upsert) ─────────────────
  await supabase
    .from('domain_agent_sources')
    .upsert(
      {
        user_id: item.user_id,
        agent_id: agentId,
        source_id: sourceId,
        association_type: 'primary',
      },
      { onConflict: 'agent_id,source_id' }
    );

  // ── Step 3: Ingestion-time analysis via Gemini ────────────────────────────
  // Gather inputs for the prompt
  const [nodesResult, chunksResult, agentResult, questionsResult] = await Promise.all([
    // Entities from the new source
    supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type, description')
      .eq('source_id', sourceId)
      .eq('user_id', item.user_id)
      .limit(50),
    // Top chunks from the new source
    supabase
      .from('source_chunks')
      .select('content')
      .eq('source_id', sourceId)
      .eq('user_id', item.user_id)
      .order('chunk_index', { ascending: true })
      .limit(8),
    // Agent's current expertise index
    supabase
      .from('domain_agents')
      .select('expertise_index')
      .eq('id', agentId)
      .single(),
    // Open standing questions
    supabase
      .from('agent_standing_questions')
      .select('id, question, question_type, status')
      .eq('agent_id', agentId)
      .in('status', ['open', 'partially_addressed'])
      .limit(20),
  ]);

  const nodes = (nodesResult.data ?? []) as Array<{
    id: string; label: string; entity_type: string; description: string;
  }>;
  const chunks = (chunksResult.data ?? []) as Array<{ content: string }>;
  const expertiseIndex = (agentResult.data as { expertise_index: Record<string, unknown> } | null)?.expertise_index ?? {};
  const openQuestions = (questionsResult.data ?? []) as Array<{
    id: string; question: string; question_type: string; status: string;
  }>;

  // Build the analysis prompt
  const entitySummary = nodes
    .map(n => `- ${n.label} (${n.entity_type}): ${n.description}`)
    .join('\n');
  const chunkContent = chunks.map(c => c.content).join('\n---\n');
  const questionList = openQuestions
    .map(q => `- [${q.id}] (${q.question_type}, ${q.status}): ${q.question}`)
    .join('\n');

  const analysisPrompt = `You are an advisory council analyst for a personal knowledge graph.
A new source has been ingested into a domain agent's scope. Analyse it for patterns.

## New Source Entities
${entitySummary || '(none extracted)'}

## New Source Content (key chunks)
${chunkContent || '(no chunks)'}

## Agent's Current Expertise Index
${JSON.stringify(expertiseIndex, null, 2)}

## Open Standing Questions
${questionList || '(none)'}

## Your Task
Analyse the new content and return structured JSON with exactly these three fields:

1. **insights**: Array of patterns detected. Types:
   - "tension": Content contradicts or disagrees with existing knowledge
   - "convergence": Content independently corroborates existing patterns
   - "novel_connection": Previously unlinked entities are now connected
   Only report specific, evidence-backed patterns. Return empty array if none.

2. **question_updates**: Array of standing questions affected by this content.
   Return the question ID, new_status ("partially_addressed" or "answered"), and evidence.
   Return empty array if no questions are addressed.

3. **contribution_summary**: One sentence describing what this source adds.

Return ONLY valid JSON matching this schema:
{
  "insights": [{ "type": "tension|convergence|novel_connection", "claim": "...", "evidence_summary": "...", "related_entity_labels": ["..."], "confidence": 0.0-1.0 }],
  "question_updates": [{ "question_id": "uuid", "new_status": "partially_addressed|answered", "evidence": "..." }],
  "contribution_summary": "..."
}`;

  let analysis: AdvisoryAnalysisResult = {
    insights: [],
    question_updates: [],
    contribution_summary: '',
  };

  try {
    const geminiResponse = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: analysisPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (geminiResponse.ok) {
      const geminiData = await geminiResponse.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        analysis = JSON.parse(text) as AdvisoryAnalysisResult;
      }
    } else {
      console.warn(`[advisory-council] Gemini analysis call failed: ${geminiResponse.status}`);
    }
  } catch (err) {
    console.warn('[advisory-council] Gemini analysis failed:', err);
  }

  // ── Step 4: Persist insights ──────────────────────────────────────────────
  if (analysis.insights.length > 0) {
    // Build a label→id lookup from the source's nodes
    const labelToIds = new Map<string, string>();
    for (const n of nodes) {
      labelToIds.set(n.label.toLowerCase(), n.id);
    }

    const insightRows = analysis.insights.map(ins => ({
      user_id: item.user_id,
      agent_id: agentId,
      insight_type: ins.type,
      claim: ins.claim,
      evidence_summary: ins.evidence_summary,
      trigger_source_id: sourceId,
      related_entity_ids: ins.related_entity_labels
        .map(label => labelToIds.get(label.toLowerCase()))
        .filter((id): id is string => !!id),
      confidence: ins.confidence,
      status: 'active',
    }));

    const { error: insightError } = await supabase
      .from('agent_insights')
      .insert(insightRows);

    if (insightError) {
      console.warn('[advisory-council] Failed to insert insights:', insightError.message);
    } else {
      console.log(`[advisory-council] Inserted ${insightRows.length} insights`);
    }
  }

  // ── Step 5: Update standing questions ─────────────────────────────────────
  for (const qu of analysis.question_updates) {
    // Validate the question_id is a real open question for this agent
    const validQuestion = openQuestions.find(q => q.id === qu.question_id);
    if (!validQuestion) continue;

    // Append source_id to addressing_source_ids array
    const { error: qError } = await supabase.rpc('append_to_uuid_array', {
      p_table: 'agent_standing_questions',
      p_id: qu.question_id,
      p_column: 'addressing_source_ids',
      p_value: sourceId,
    }).then(
      // If the RPC doesn't exist, fall back to a direct update
      () => ({ error: null }),
      () => ({ error: null })
    );

    // Direct update for status + evidence (always runs)
    await supabase
      .from('agent_standing_questions')
      .update({
        status: qu.new_status,
        addressing_evidence: qu.evidence,
        status_changed_at: new Date().toISOString(),
      })
      .eq('id', qu.question_id)
      .eq('agent_id', agentId);

    // Also append source_id to the array via raw update
    // Postgres: addressing_source_ids = array_append(addressing_source_ids, sourceId)
    await supabase.rpc('append_addressing_source', {
      p_question_id: qu.question_id,
      p_source_id: sourceId,
    }).catch(() => {
      // If RPC doesn't exist, do a read-modify-write
      void (async () => {
        const { data: qRow } = await supabase
          .from('agent_standing_questions')
          .select('addressing_source_ids')
          .eq('id', qu.question_id)
          .single();
        const existing = ((qRow as { addressing_source_ids: string[] } | null)?.addressing_source_ids) ?? [];
        if (!existing.includes(sourceId)) {
          await supabase
            .from('agent_standing_questions')
            .update({ addressing_source_ids: [...existing, sourceId] })
            .eq('id', qu.question_id);
        }
      })();
    });

    if (qError) {
      console.warn(`[advisory-council] Question update failed for ${qu.question_id}:`, qError);
    }
  }

  if (analysis.question_updates.length > 0) {
    console.log(`[advisory-council] Updated ${analysis.question_updates.length} standing questions`);
  }

  // ── Step 6: Detect cross-domain signals (no LLM call) ─────────────────────
  // Find edges where one node belongs to the new source and the other belongs
  // to a different domain agent's scope.
  const newSourceNodeIds = nodes.map(n => n.id);

  if (newSourceNodeIds.length > 0) {
    // Get all edges involving nodes from this source
    const { data: outEdges } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, evidence')
      .eq('user_id', item.user_id)
      .in('source_node_id', newSourceNodeIds);

    const { data: inEdges } = await supabase
      .from('knowledge_edges')
      .select('id, source_node_id, target_node_id, evidence')
      .eq('user_id', item.user_id)
      .in('target_node_id', newSourceNodeIds);

    type EdgeRow = { id: string; source_node_id: string; target_node_id: string; evidence: string | null };
    const allEdges = [...((outEdges ?? []) as EdgeRow[]), ...((inEdges ?? []) as EdgeRow[])];

    // Collect "other side" node IDs (nodes NOT from the new source)
    const newNodeSet = new Set(newSourceNodeIds);
    const otherNodeIds = new Set<string>();
    for (const e of allEdges) {
      if (!newNodeSet.has(e.source_node_id)) otherNodeIds.add(e.source_node_id);
      if (!newNodeSet.has(e.target_node_id)) otherNodeIds.add(e.target_node_id);
    }

    if (otherNodeIds.size > 0) {
      // Find which domain agents own these other nodes (via domain_agent_sources → knowledge_nodes.source_id)
      const otherNodeIdArr = Array.from(otherNodeIds);
      const { data: otherNodes } = await supabase
        .from('knowledge_nodes')
        .select('id, source_id')
        .in('id', otherNodeIdArr.slice(0, 200)); // Cap to avoid oversized IN clause

      const nodeSourceMap = new Map<string, string>();
      for (const n of ((otherNodes ?? []) as Array<{ id: string; source_id: string | null }>)) {
        if (n.source_id) nodeSourceMap.set(n.id, n.source_id);
      }

      const otherSourceIds = [...new Set(Array.from(nodeSourceMap.values()))];
      if (otherSourceIds.length > 0) {
        const { data: otherAgentSources } = await supabase
          .from('domain_agent_sources')
          .select('agent_id, source_id')
          .in('source_id', otherSourceIds.slice(0, 200))
          .neq('agent_id', agentId); // Exclude our own agent

        const sourceToAgents = new Map<string, Set<string>>();
        for (const das of ((otherAgentSources ?? []) as Array<{ agent_id: string; source_id: string }>)) {
          if (!sourceToAgents.has(das.source_id)) sourceToAgents.set(das.source_id, new Set());
          sourceToAgents.get(das.source_id)!.add(das.agent_id);
        }

        // Get existing bridge_edge_ids to dedup
        const edgeIds = allEdges.map(e => e.id);
        const { data: existingSignals } = await supabase
          .from('agent_signals')
          .select('bridge_edge_id')
          .in('bridge_edge_id', edgeIds.slice(0, 200));

        const existingBridgeEdges = new Set(
          ((existingSignals ?? []) as Array<{ bridge_edge_id: string | null }>)
            .map(s => s.bridge_edge_id)
            .filter((id): id is string => !!id)
        );

        // Create signals for each cross-domain edge
        const signalRows: Array<Record<string, unknown>> = [];
        for (const edge of allEdges) {
          if (existingBridgeEdges.has(edge.id)) continue; // Already signalled

          const otherNodeId = newNodeSet.has(edge.source_node_id)
            ? edge.target_node_id
            : edge.source_node_id;
          const otherSourceId = nodeSourceMap.get(otherNodeId);
          if (!otherSourceId) continue;

          const targetAgents = sourceToAgents.get(otherSourceId);
          if (!targetAgents) continue;

          for (const targetAgentId of targetAgents) {
            signalRows.push({
              user_id: item.user_id,
              source_agent_id: agentId,
              target_agent_id: targetAgentId,
              trigger_source_id: sourceId,
              bridge_entity_ids: [edge.source_node_id, edge.target_node_id],
              bridge_edge_id: edge.id,
              reason: edge.evidence ?? 'Cross-domain edge detected during ingestion',
              status: 'pending',
            });
          }
        }

        if (signalRows.length > 0) {
          // Batch insert (dedup on bridge_edge_id already handled above)
          const { error: sigError } = await supabase
            .from('agent_signals')
            .insert(signalRows);

          if (sigError) {
            console.warn('[advisory-council] Failed to insert signals:', sigError.message);
          } else {
            console.log(`[advisory-council] Created ${signalRows.length} cross-domain signals`);
          }
        }
      }
    }
  }

  // ── Step 7: Flag expertise index as stale, update counters ────────────────
  // Count entities across all of this agent's sources
  const { count: entityCount } = await supabase
    .from('knowledge_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', item.user_id)
    .in('source_id',
      await supabase
        .from('domain_agent_sources')
        .select('source_id')
        .eq('agent_id', agentId)
        .then(r => ((r.data ?? []) as Array<{ source_id: string }>).map(d => d.source_id))
    );

  const { count: sourceCount } = await supabase
    .from('domain_agent_sources')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  await supabase
    .from('domain_agents')
    .update({
      index_stale: true,
      last_ingestion_at: new Date().toISOString(),
      source_count: sourceCount ?? 0,
      entity_count: entityCount ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId);

  console.log(`[advisory-council] Hook completed in ${Date.now() - hookStart}ms — agent ${agentId} updated`);
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
      .select('id, user_id, channel_id, video_id, video_title, video_url, thumbnail_url, published_at, duration_seconds, transcript, status, retry_count, max_retries, error_message, playlist_id')
      .eq('status', 'transcript_ready')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      query = query.eq('user_id', userId);
    }

    const { data: pendingItems, error: fetchError } = await query;

    if (fetchError) {
      console.error('[extract-knowledge] Queue query failed:', fetchError.message);
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

    // Fetch playlist settings separately (resilient — falls back to defaults)
    const playlistIds = [...new Set(
      (pendingItems as Array<Record<string, unknown>>)
        .map(r => r['playlist_id'] as string | null)
        .filter((id): id is string => !!id)
    )];
    const playlistMap = new Map<string, Record<string, unknown>>();
    if (playlistIds.length > 0) {
      try {
        const { data: playlists } = await supabase
          .from('youtube_playlists')
          .select('id, extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions')
          .in('id', playlistIds);
        for (const p of (playlists ?? []) as Array<Record<string, unknown>>) {
          playlistMap.set(p['id'] as string, p);
        }
      } catch (err) {
        console.warn('[extract-knowledge] Playlist settings lookup failed, using defaults:', err);
      }
    }

    // Map queue items with playlist settings (or defaults)
    const items: QueueItem[] = (pendingItems as Array<Record<string, unknown>>).map(row => {
      const playlist = playlistMap.get(row['playlist_id'] as string) ?? null;
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
        playlist_id: row['playlist_id'] as string | null,
        extraction_mode: (playlist?.['extraction_mode'] as string) ?? undefined,
        anchor_emphasis: (playlist?.['anchor_emphasis'] as string) ?? undefined,
        linked_anchor_ids: (playlist?.['linked_anchor_ids'] as string[]) ?? [],
        custom_instructions: (playlist?.['custom_instructions'] as string | null) ?? undefined,
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
