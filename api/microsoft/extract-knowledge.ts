import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

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
const EMBEDDING_CONCURRENCY = 5;
const TIME_BUDGET_MS = 50_000;

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  microsoft_resource_id: string;
  resource_type: string;
  title: string | null;
  content: string;
  event_start: string | null;
  event_end: string | null;
  attendees: string | null;
}

// ─── PARTICIPANT PARSER (inlined — serverless cannot import local files) ──────

function toTitleCase(name: string): string {
  return name.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parseMeetingParticipants(content: string, attendeesJson: string | null): string[] | null {
  // Strategy 1: Parse from content header
  if (content) {
    const lines = content.split('\n').slice(0, 30);
    for (const line of lines) {
      const match = line.match(/^\*\*(?:People|Participants|Attendees)\*\*:\s*(.+)$/i);
      if (!match?.[1]) continue;
      const raw = match[1].trim();
      if (!raw) continue;
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
      const result: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] ?? '';
        if (i === parts.length - 1 && /\band\b/i.test(part)) {
          result.push(...part.split(/\band\b/i).map(s => s.trim()).filter(Boolean).map(toTitleCase));
        } else {
          result.push(toTitleCase(part));
        }
      }
      if (result.length > 0) return [...new Set(result)];
    }
  }
  // Strategy 2: Fall back to attendees from queue metadata
  if (attendeesJson) {
    try {
      const attendees = JSON.parse(attendeesJson) as string[];
      if (Array.isArray(attendees) && attendees.length > 0) {
        return [...new Set(attendees.map(a => toTitleCase(String(a))))];
      }
    } catch { /* ignore parse errors */ }
  }
  return null;
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

interface UserProfile {
  professional_context?: { role?: string; current_projects?: string };
  personal_interests?: { topics?: string };
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser(token);
  return data?.user?.id ?? null;
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────

async function callGemini(systemPrompt: string, content: string): Promise<ExtractionResult> {
  const res = await fetch(`${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: content.slice(0, MAX_CONTENT_CHARS) }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(text) as ExtractionResult;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${GEMINI_BASE}/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status}`);
  const data = await res.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values || [];
}

async function batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_CONCURRENCY) {
    const batch = texts.slice(i, i + EMBEDDING_CONCURRENCY);
    const embeddings = await Promise.all(batch.map(t => generateEmbedding(t).catch(() => [])));
    results.push(...embeddings);
  }
  return results;
}

// ─── EXTRACTION ───────────────────────────────────────────────────────────────

function buildSystemPrompt(
  resourceType: string,
  profile: UserProfile | null,
  mode: string,
  anchorLabels: string[]
): string {
  const typeLabel = resourceType === 'meeting_transcript'
    ? 'meeting transcript'
    : resourceType === 'calendar_event'
      ? 'calendar event'
      : 'email';

  let prompt = `You are an expert knowledge extraction AI. Analyze this ${typeLabel} and extract structured entities and relationships.

Return a JSON object with:
- "entities": array of { "label": string, "entity_type": string, "description": string, "confidence": number (0-1), "tags": string[] }
- "relationships": array of { "source": string, "target": string, "relation_type": string, "evidence": string }

Entity types: Person, Organization, Team, Topic, Project, Goal, Action, Risk, Blocker, Decision, Insight, Question, Idea, Concept, Takeaway, Lesson, Document, Event, Location, Technology, Product, Metric, Hypothesis

Relationship types: leads_to, supports, blocks, depends_on, part_of, authored, mentions, conflicts_with, relates_to, enables, created, achieved, produced, contradicts, risks, prevents, challenges, inhibits, connected_to, owns, associated_with`;

  if (mode === 'strategic') {
    prompt += '\n\nFocus on high-level strategic concepts: decisions, goals, risks, and key insights. Skip minor details.';
  } else if (mode === 'actionable') {
    prompt += '\n\nFocus on actionable items: actions, goals, blockers, decisions, deadlines. Prioritize what needs to happen next.';
  } else if (mode === 'relational') {
    prompt += '\n\nFocus on connections between people, teams, and projects. Map who works with whom and on what.';
  }

  if (profile?.professional_context?.role) {
    prompt += `\n\nThe user is a ${profile.professional_context.role}.`;
  }

  if (anchorLabels.length > 0) {
    prompt += `\n\nPay special attention to concepts related to these focus areas (anchors): ${anchorLabels.join(', ')}. Create relationships connecting extracted entities to these anchors where relevant.`;
  }

  return prompt;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const isCron = verifyCronAuth(req);
  const userId = isCron ? null : await getUserFromToken(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const startTime = Date.now();

  try {
    let query = supabase
      .from('microsoft_ingestion_queue')
      .select('*')
      .eq('status', 'content_ready')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: items } = await query;

    if (!items?.length) {
      return res.status(200).json({ processed: 0 });
    }

    let processed = 0;

    for (const item of items as QueueItem[]) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;

      // Mark as extracting
      await supabase.from('microsoft_ingestion_queue').update({
        status: 'extracting',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', item.id);

      try {
        // Fetch user profile and integration settings
        const [profileRes, integrationRes] = await Promise.all([
          supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
          supabase.from('microsoft_integrations').select('extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions').eq('user_id', item.user_id).maybeSingle(),
        ]);

        const profile = profileRes.data as UserProfile | null;
        const settings = integrationRes.data as { extraction_mode: string; linked_anchor_ids: string[] | null } | null;
        const mode = settings?.extraction_mode || 'comprehensive';

        // Fetch anchor labels if linked
        let anchorLabels: string[] = [];
        if (settings?.linked_anchor_ids?.length) {
          const { data: anchors } = await supabase
            .from('knowledge_nodes')
            .select('label')
            .in('id', settings.linked_anchor_ids);
          anchorLabels = (anchors || []).map((a: { label: string }) => a.label);
        }

        const systemPrompt = buildSystemPrompt(item.resource_type, profile, mode, anchorLabels);
        const result = await callGemini(systemPrompt, item.content);

        if (!result.entities?.length) {
          await supabase.from('microsoft_ingestion_queue').update({
            status: 'completed',
            nodes_created: 0,
            edges_created: 0,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
          processed++;
          continue;
        }

        // Determine source type
        const sourceType = item.resource_type === 'meeting_transcript' || item.resource_type === 'calendar_event'
          ? 'Meeting' : 'Research';

        // Parse participants for meeting sources
        const participants = sourceType === 'Meeting'
          ? parseMeetingParticipants(item.content, item.attendees)
          : null;

        // Save knowledge source
        const insertRow: Record<string, unknown> = {
          user_id: item.user_id,
          title: item.title || 'Microsoft 365 Import',
          content: item.content.slice(0, 50000),
          source_type: sourceType,
          metadata: {
            provider: 'microsoft',
            resource_type: item.resource_type,
            microsoft_resource_id: item.microsoft_resource_id,
            event_start: item.event_start,
            event_end: item.event_end,
            attendees: item.attendees ? JSON.parse(item.attendees) : null,
          },
        };
        if (participants) {
          insertRow.participants = participants;
        }

        const { data: source } = await supabase
          .from('knowledge_sources')
          .insert(insertRow)
          .select('id')
          .single();

        const sourceId = source?.id;

        // Save nodes
        const nodeInserts = result.entities.map(e => ({
          user_id: item.user_id,
          label: e.label,
          entity_type: e.entity_type,
          description: e.description,
          confidence: e.confidence,
          source: item.title || 'Microsoft 365',
          source_type: sourceType,
          source_id: sourceId,
          tags: e.tags || [],
          is_anchor: false,
          is_merged: false,
        }));

        const { data: savedNodes } = await supabase
          .from('knowledge_nodes')
          .insert(nodeInserts)
          .select('id, label');

        const nodeMap = new Map<string, string>();
        for (const node of savedNodes || []) {
          nodeMap.set((node as { id: string; label: string }).label.toLowerCase(), (node as { id: string; label: string }).id);
        }

        // Save edges
        let edgesCreated = 0;
        if (result.relationships?.length && nodeMap.size > 0) {
          const edgeInserts = result.relationships
            .map(r => {
              const sourceId = nodeMap.get(r.source.toLowerCase());
              const targetId = nodeMap.get(r.target.toLowerCase());
              if (!sourceId || !targetId || sourceId === targetId) return null;
              return {
                user_id: item.user_id,
                source_node_id: sourceId,
                target_node_id: targetId,
                relation_type: r.relation_type,
                evidence: r.evidence,
                weight: 1.0,
              };
            })
            .filter(Boolean);

          if (edgeInserts.length > 0) {
            const { data: savedEdges } = await supabase
              .from('knowledge_edges')
              .insert(edgeInserts)
              .select('id');
            edgesCreated = savedEdges?.length || 0;
          }
        }

        // Generate embeddings for nodes
        if (savedNodes?.length && Date.now() - startTime < TIME_BUDGET_MS) {
          const texts = (savedNodes as Array<{ id: string; label: string }>).map(
            n => result.entities.find(e => e.label === n.label)
              ? `${n.label}: ${result.entities.find(e => e.label === n.label)?.description || ''}`
              : n.label
          );

          const embeddings = await batchGenerateEmbeddings(texts);

          for (let i = 0; i < savedNodes.length && i < embeddings.length; i++) {
            if (embeddings[i].length > 0) {
              await supabase.from('knowledge_nodes').update({
                embedding: embeddings[i],
              }).eq('id', (savedNodes[i] as { id: string }).id);
            }
          }
        }

        // Mark as completed
        await supabase.from('microsoft_ingestion_queue').update({
          status: 'completed',
          source_id: sourceId,
          nodes_created: savedNodes?.length || 0,
          edges_created: edgesCreated,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);

        processed++;
      } catch (err) {
        console.error(`[microsoft/extract-knowledge] Error processing ${item.id}:`, err);
        await supabase.from('microsoft_ingestion_queue').update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Extraction failed',
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);
      }
    }

    return res.status(200).json({ processed });
  } catch (err) {
    console.error('[microsoft/extract-knowledge] Error:', err);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}
