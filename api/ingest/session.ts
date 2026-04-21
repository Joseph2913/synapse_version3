import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

// Allow up to 120s on Vercel Pro (Gemini extraction + embeddings)
export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const INGEST_SECRET = process.env.INGEST_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_CONTENT_CHARS = 100_000;
const GEMINI_MAX_RETRIES = 3;

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyIngestSecret(req: VercelRequest): boolean {
  if (!INGEST_SECRET) return false;
  const secret = req.headers['x-ingest-secret'] as string | undefined;
  return secret === INGEST_SECRET;
}

// ─── GEMINI HELPERS (inlined — serverless cannot import local files) ──────────

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .trim();
}

async function fetchWithRetry(url: string, options: RequestInit, retries = GEMINI_MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      console.log(`[ingest/session] Gemini 429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return response;
  }
  throw new Error('Gemini request failed after retries');
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

async function generateSummary(content: string): Promise<string> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a concise summarizer. Produce a 2-3 sentence summary of the following content. Focus on what was accomplished, decided, or discovered.' }] },
        contents: [{ parts: [{ text: content.slice(0, 30000) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) return '';
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── EXTRACTION ────────────────────────────────────────────────────────────────

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

function buildExtractionPrompt(config: {
  anchors: Array<{ label: string; entity_type: string; description: string }>;
  userProfile: { professional_context?: { role?: string; current_projects?: string }; personal_interests?: { topics?: string } } | null;
  customGuidance?: string | null;
}): string {
  let prompt = `You are a knowledge extraction system. Extract structured knowledge from a Claude Code session summary.

## Extraction Mode: comprehensive
Extract the maximum number of meaningful entities and all significant relationships. Capture every person, organization, concept, decision, and insight mentioned.

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
    prompt += `\n\n## Anchor Context (Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.):\n`;
    for (const anchor of config.anchors.slice(0, 10)) {
      prompt += `- ${anchor.label} (${anchor.entity_type}): ${anchor.description}\n`;
    }
  }

  if (config.customGuidance) {
    prompt += `\n\n## Additional Instructions:\n${config.customGuidance}`;
  }

  prompt += '\n\nExtract knowledge from the following session summary. Return ONLY valid JSON matching the schema above.';
  return prompt;
}

async function extractEntities(content: string, systemPrompt: string): Promise<ExtractionResult> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: content.slice(0, MAX_CONTENT_CHARS) }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
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

// ─── BACKGROUND PIPELINE ──────────────────────────────────────────────────────

async function runExtractionPipeline(params: {
  sourceId: string;
  userId: string;
  title: string;
  content: string;
  guidance?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { sourceId, userId, title, content, guidance, metadata } = params;
  const startTime = Date.now();
  const supabase = getSupabase();

  const updateStatus = async (status: string, extra?: Record<string, unknown>) => {
    const meta = { ...metadata, extraction_status: status, ...extra };
    await supabase.from('knowledge_sources').update({ metadata: meta }).eq('id', sourceId);
  };

  try {
    await updateStatus('processing', { processing_started_at: new Date().toISOString() });

    // ── STEP 2: GENERATE SUMMARY ────────────────────────────────────────────
    const rawSummary = await generateSummary(content);
    const summary = rawSummary ? stripMarkdown(rawSummary) : '';
    if (summary) {
      await supabase
        .from('knowledge_sources')
        .update({ summary, summary_source: 'generated' })
        .eq('id', sourceId);
    }

    // ── STEP 3: FETCH EXTRACTION CONFIG ─────────────────────────────────────
    const [profileResult, anchorsResult] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('user_id', userId)
        .eq('is_anchor', true)
        .limit(10),
    ]);

    const userProfile = profileResult.data as { professional_context?: { role?: string; current_projects?: string }; personal_interests?: { topics?: string } } | null;
    const anchors = (anchorsResult.data ?? []) as Array<{ label: string; entity_type: string; description: string }>;

    // ── STEP 4: GEMINI EXTRACTION ───────────────────────────────────────────
    const systemPrompt = buildExtractionPrompt({
      anchors,
      userProfile,
      customGuidance: guidance,
    });

    const extraction = await extractEntities(content, systemPrompt);
    const { entities = [], relationships = [] } = extraction;
    console.log(`[ingest/session] Source ${sourceId}: extracted ${entities.length} entities, ${relationships.length} relationships`);

    // ── STEP 5: DEDUP + SAVE NODES ──────────────────────────────────────────
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

    // 5A: Exact-match deduplication
    const entityLabels = entities.filter(e => e.label && e.entity_type).map(e => e.label);
    const { data: existingNodes } = await supabase
      .from('knowledge_nodes')
      .select('id, label, entity_type')
      .eq('user_id', userId)
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

    // 5B: Fuzzy/semantic dedup for unmatched entities
    const fuzzyMergeMap = new Map<string, string>();
    const prefetchedEmbeddings = new Map<string, number[]>();

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
                p_user_id: userId,
                p_label: entity.label,
                p_entity_type: entity.entity_type,
                p_embedding: embedding,
                p_exact_threshold: 0.92,
                p_semantic_threshold: 0.88,
              });
              const best = (matches as Array<{
                match_id: string; match_label: string; match_type: string; similarity: number;
              }> | null)?.[0];
              if (best && (best.match_type === 'exact' || (best.match_type === 'fuzzy' && best.similarity >= 0.95))) {
                fuzzyMergeMap.set(entity.label.toLowerCase(), best.match_id);
              }
            }
          } catch (err) {
            console.warn(`[ingest/session] Dedup check failed for "${entity.label}":`, err);
          }
        })
      );
    }

    for (const [labelLower, existingId] of fuzzyMergeMap) {
      const entity = entities.find(e => e.label.toLowerCase() === labelLower);
      if (entity) savedNodeMap.set(entity.label, existingId);
    }

    // 5C: Insert new nodes
    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;
      if (exactMatchMap.has(entity.label.toLowerCase())) continue;
      if (fuzzyMergeMap.has(entity.label.toLowerCase())) continue;

      const { data: nodeData, error: nodeError } = await supabase
        .from('knowledge_nodes')
        .insert({
          user_id: userId,
          label: entity.label,
          entity_type: entity.entity_type,
          description: entity.description ?? null,
          confidence: entity.confidence ?? 0.8,
          source: title,
          source_type: 'GitHub',
          source_id: sourceId,
          tags: entity.tags ?? [],
        })
        .select('id')
        .single();

      if (nodeError) {
        const { data: existing } = await supabase
          .from('knowledge_nodes')
          .select('id')
          .eq('user_id', userId)
          .eq('label', entity.label)
          .maybeSingle();
        if (existing) savedNodeMap.set(entity.label, (existing as { id: string }).id);
        continue;
      }

      if (nodeData) {
        savedNodeMap.set(entity.label, (nodeData as { id: string }).id);
        nodesCreated++;
      }
    }

    // ── STEP 6: GENERATE EMBEDDINGS ─────────────────────────────────────────
    const nodeEmbeddings = new Map<string, number[]>();
    const embeddingTasks = [...savedNodeMap.entries()]
      .map(([label, nodeId]) => {
        const entity = entities.find(e => e.label === label);
        const isReused = exactMatchMap.has(label.toLowerCase()) || fuzzyMergeMap.has(label.toLowerCase());
        return entity && !isReused ? { label, nodeId, entity } : null;
      })
      .filter((t): t is { label: string; nodeId: string; entity: (typeof entities)[0] } => t !== null);

    const EMBEDDING_CONCURRENCY = 5;
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
              await supabase.from('knowledge_nodes').update({ embedding }).eq('id', nodeId);
            }
          } catch (err) {
            console.warn(`[ingest/session] Embedding failed for node ${label}:`, err);
          }
        })
      );
    }

    // ── STEP 7: SAVE EDGES ──────────────────────────────────────────────────
    let edgesCreated = 0;

    for (const rel of relationships) {
      const sourceNodeId = savedNodeMap.get(rel.source);
      const targetNodeId = savedNodeMap.get(rel.target);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;

      const { error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert({
          user_id: userId,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type ?? 'relates_to',
          evidence: rel.evidence ?? null,
          weight: 1.0,
        });
      if (!edgeError) edgesCreated++;
    }

    // ── STEP 8: CHUNK + EMBED SOURCE ────────────────────────────────────────
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        const embedding = await generateEmbedding(chunk);
        await supabase.from('source_chunks').insert({
          user_id: userId,
          source_id: sourceId,
          chunk_index: i,
          content: chunk,
          embedding: embedding.length > 0 ? embedding : null,
        });
      } catch (err) {
        console.warn(`[ingest/session] Chunk ${i} failed:`, err);
      }
    }

    // ── STEP 9: CROSS-CONNECTION DISCOVERY ──────────────────────────────────
    let crossConnectionCount = 0;
    if (savedNodeMap.size > 0 && nodeEmbeddings.size > 0) {
      try {
        const newNodeIds = new Set(savedNodeMap.values());
        type SemanticCandidate = { id: string; label: string; entity_type: string; description: string | null };
        const candidateMap = new Map<string, SemanticCandidate>();

        for (const [_nodeId, embedding] of nodeEmbeddings) {
          const { data: similar } = await supabase.rpc('match_knowledge_nodes', {
            query_embedding: embedding,
            match_threshold: 0.55,
            match_count: 30,
            p_user_id: userId,
          });
          for (const s of similar ?? []) {
            if (!newNodeIds.has(s.id)) {
              candidateMap.set(s.id, s as SemanticCandidate);
            }
          }
        }

        const existingCandidates = [...candidateMap.values()].slice(0, 40);

        if (existingCandidates.length > 0) {
          const newEntityLines = entities.slice(0, 20)
            .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');
          const existingEntityLines = existingCandidates
            .map(e => `- [${e.entity_type}] ${e.label}: ${e.description ?? ''}`)
            .join('\n');

          const crossPrompt = `You are building a knowledge graph. Identify meaningful cross-source relationships between new and existing entities.

NEW entities (just extracted from a Claude Code session):
${newEntityLines}

EXISTING entities (already in the user's knowledge graph):
${existingEntityLines}

Rules:
- Only return connections where a meaningful, non-trivial relationship exists.
- Do NOT connect entities simply because they share a label or topic.
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
                const existingNodeMap = new Map(existingCandidates.map(n => [n.label.toLowerCase(), n.id]));

                for (const rel of crossResult.relationships ?? []) {
                  const srcId = savedNodeMap.get(rel.source) ?? existingNodeMap.get(rel.source?.toLowerCase());
                  const tgtId = savedNodeMap.get(rel.target) ?? existingNodeMap.get(rel.target?.toLowerCase());
                  if (srcId && tgtId && srcId !== tgtId) {
                    await supabase.from('knowledge_edges').insert({
                      user_id: userId,
                      source_node_id: srcId,
                      target_node_id: tgtId,
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
        console.warn('[ingest/session] Cross-connection discovery failed:', err);
      }
    }

    // ── STEP 10: TRIGGER ANCHOR SCORING (fire-and-forget) ───────────────────
    const savedNodeIds = Array.from(savedNodeMap.values());
    if (savedNodeIds.length > 0) {
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';
      const CRON_SECRET = process.env.CRON_SECRET;

      fetch(`${appUrl}/api/anchors/score-post-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({ userId, sourceId, nodeIds: savedNodeIds }),
      }).catch(err => {
        console.warn('[ingest/session] Anchor scoring trigger failed (non-fatal):', err);
      });
    }

    // ── COMPLETE ────────────────────────────────────────────────────────────
    await updateStatus('completed', {
      processing_completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    console.log(`[ingest/session] Complete: ${nodesCreated} nodes, ${edgesCreated} edges (${crossConnectionCount} cross), ${chunks.length} chunks in ${Date.now() - startTime}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Pipeline error:', err);
    await updateStatus('error', {
      error: msg,
      failed_at: new Date().toISOString(),
    }).catch(() => { /* best-effort status update */ });
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyIngestSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    userId,
    title,
    content,
    repo,
    branch,
    guidance,
  } = req.body as {
    userId: string;
    title: string;
    content: string;
    repo?: string;
    branch?: string;
    guidance?: string;
  };

  if (!userId || !title || !content) {
    return res.status(400).json({ error: 'Missing required fields: userId, title, content' });
  }

  const supabase = getSupabase();

  try {
    // ── STEP 1: SAVE SOURCE ──────────────────────────────────────────────────
    const metadata: Record<string, unknown> = {
      ingested_via: 'mcp_session',
      extraction_status: 'accepted',
      repo: repo ?? null,
      branch: branch ?? null,
      guidance: guidance ?? null,
      session_date: new Date().toISOString(),
    };

    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: userId,
        title,
        source_type: 'GitHub',
        content: content.slice(0, MAX_CONTENT_CHARS),
        metadata,
      })
      .select('id')
      .single();

    if (sourceError) {
      throw new Error(`Failed to save source: ${sourceError.message}`);
    }

    const sourceId = (sourceData as { id: string }).id;
    console.log(`[ingest/session] Saved source "${title}" (${sourceId}) for user ${userId}, dispatching background pipeline`);

    // Fire extraction pipeline in background via waitUntil
    waitUntil(runExtractionPipeline({
      sourceId,
      userId,
      title,
      content: content.slice(0, MAX_CONTENT_CHARS),
      guidance,
      metadata,
    }));

    return res.status(202).json({
      source_id: sourceId,
      title,
      status: 'processing',
      message: 'Source accepted. Extraction pipeline running in background.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ingest/session] Error:', err);
    return res.status(500).json({
      success: false,
      error: msg,
    });
  }
}
