import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import { readFileSync } from 'fs';
import JSZip from 'jszip';

// ─── CONFIG ────────────────────────────────────────────────────────────────────

export const config = {
  api: { bodyParser: false },
};

export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const MAX_CONVERSATIONS = 200;
const MAX_TEXT_CHARS = 100_000;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface GeminiAnalysis {
  professionalContext: string;
  interests: string[];
  entities: Array<{ label: string; type: string; mentionCount: number }>;
  candidateAnchors: Array<{ label: string; mentionCount: number }>;
}

// ─── PARSERS ───────────────────────────────────────────────────────────────────

function parseChatGPTExport(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('ChatGPT export is not valid JSON');
  }

  if (!Array.isArray(data)) {
    throw new Error('ChatGPT export must be a JSON array');
  }

  const conversations = (data as unknown[]).slice(0, MAX_CONVERSATIONS);
  const parts: string[] = [];

  for (const conv of conversations) {
    if (typeof conv !== 'object' || conv === null) continue;
    const c = conv as Record<string, unknown>;
    const title = typeof c.title === 'string' ? c.title : 'Untitled';
    parts.push(`\n=== ${title} ===`);

    const mapping = c.mapping;
    if (typeof mapping !== 'object' || mapping === null) continue;

    for (const node of Object.values(mapping as Record<string, unknown>)) {
      if (typeof node !== 'object' || node === null) continue;
      const n = node as Record<string, unknown>;
      const message = n.message;
      if (typeof message !== 'object' || message === null) continue;
      const msg = message as Record<string, unknown>;

      const author = msg.author as Record<string, unknown> | null;
      const role = author?.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = msg.content as Record<string, unknown> | null;
      const textParts = content?.parts;
      if (!Array.isArray(textParts)) continue;

      const text = textParts
        .filter((p): p is string => typeof p === 'string')
        .join(' ')
        .trim();

      if (text) {
        parts.push(`[${role}]: ${text}`);
      }
    }
  }

  return parts.join('\n');
}

async function parseClaudeExport(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: string[] = [];
  let count = 0;

  const files = Object.entries(zip.files)
    .filter(([name, file]) => name.endsWith('.json') && !file.dir)
    .slice(0, MAX_CONVERSATIONS);

  for (const [, file] of files) {
    if (count >= MAX_CONVERSATIONS) break;

    const raw = await file.async('string');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    if (typeof data !== 'object' || data === null) continue;
    const conv = data as Record<string, unknown>;

    const messages = conv.chat_messages;
    if (!Array.isArray(messages)) continue;

    const name = typeof conv.name === 'string' ? conv.name : 'Untitled';
    parts.push(`\n=== ${name} ===`);

    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;
      const sender = typeof m.sender === 'string' ? m.sender : null;
      const text = typeof m.text === 'string' ? m.text.trim() : null;

      if (sender && text) {
        parts.push(`[${sender}]: ${text}`);
      }
    }

    count++;
  }

  return parts.join('\n');
}

// ─── GEMINI ANALYSIS ───────────────────────────────────────────────────────────

async function analyzeConversations(combinedText: string): Promise<GeminiAnalysis> {
  const truncated = combinedText.slice(0, MAX_TEXT_CHARS);

  const prompt = `You are analyzing a person's AI conversation history to understand who they are professionally and what they care about. Extract a structured profile from the following conversations.

Return valid JSON matching this exact schema:
{
  "professionalContext": "A 2-3 sentence description of their professional role, domain, and key current projects or responsibilities",
  "interests": ["topic1", "topic2", ...],
  "entities": [
    { "label": "Entity Name", "type": "Person|Organization|Topic|Project|Technology|Concept", "mentionCount": N }
  ],
  "candidateAnchors": [
    { "label": "Anchor Name", "mentionCount": N }
  ]
}

Guidelines:
- professionalContext: infer from recurring themes, job-related questions, and project references
- interests: 5-15 topics or themes that appear frequently
- entities: up to 60 notable entities (people, companies, projects, tools, concepts) mentioned across conversations
- candidateAnchors: 8-15 high-level themes or domains that represent the person's core focus areas (suitable as knowledge graph anchors)
- mentionCount: approximate number of conversations where this entity/anchor appears

CONVERSATIONS:
${truncated}`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const result = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');

  try {
    return JSON.parse(text) as GeminiAnalysis;
  } catch {
    throw new Error('Gemini returned invalid JSON');
  }
}

// ─── DATABASE WRITES ───────────────────────────────────────────────────────────

async function saveResults(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  analysis: GeminiAnalysis,
): Promise<void> {
  // Update user profile
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({
      professional_context: { current_projects: analysis.professionalContext },
      personal_interests: { topics: analysis.interests.join(', ') },
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (profileError) {
    console.error('[process-export] Profile update error:', profileError.message);
  }

  // Prepare entity nodes (limit to 100)
  const entityNodes = analysis.entities.slice(0, 100).map((e) => ({
    user_id: userId,
    label: e.label,
    entity_type: e.type,
    description: `Extracted from AI conversation export. Mentioned approximately ${e.mentionCount} time(s).`,
    confidence: Math.min(0.9, 0.5 + e.mentionCount * 0.05),
    is_anchor: false,
    source: 'AI conversation export',
    source_type: 'Document',
  }));

  // Prepare anchor nodes
  const anchorNodes = analysis.candidateAnchors.map((a) => ({
    user_id: userId,
    label: a.label,
    entity_type: 'Anchor',
    description: `Candidate anchor identified from AI conversation export. Mentioned approximately ${a.mentionCount} time(s).`,
    confidence: Math.min(0.95, 0.6 + a.mentionCount * 0.05),
    is_anchor: true,
    source: 'AI conversation export',
    source_type: 'Document',
  }));

  const allNodes = [...entityNodes, ...anchorNodes];

  if (allNodes.length > 0) {
    const { error: nodesError } = await supabase
      .from('knowledge_nodes')
      .insert(allNodes);

    if (nodesError) {
      console.error('[process-export] Node insert error:', nodesError.message);
    }
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — simple polling endpoint
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'complete' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userId = userData.user.id;

  // Parse multipart form
  const form = formidable({ maxFileSize: 50 * 1024 * 1024 }); // 50 MB

  let filePath: string;
  let platform: string;

  try {
    const [fields, files] = await form.parse(req);

    const platformField = fields.platform?.[0];
    if (!platformField || (platformField !== 'chatgpt' && platformField !== 'claude')) {
      return res.status(400).json({ error: 'platform must be "chatgpt" or "claude"' });
    }
    platform = platformField;

    const uploadedFile = files.file?.[0];
    if (!uploadedFile?.filepath) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    filePath = uploadedFile.filepath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[process-export] Form parse error:', err);
    return res.status(400).json({ error: `Failed to parse upload: ${msg}` });
  }

  // Parse conversations
  let combinedText: string;
  try {
    const fileBuffer = readFileSync(filePath);

    if (platform === 'chatgpt') {
      combinedText = parseChatGPTExport(fileBuffer.toString('utf-8'));
    } else {
      combinedText = await parseClaudeExport(fileBuffer);
    }

    if (!combinedText.trim()) {
      return res.status(400).json({ error: 'No conversation content found in export' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[process-export] Parse error:', err);
    return res.status(400).json({ error: `Failed to parse export: ${msg}` });
  }

  // Analyze with Gemini
  let analysis: GeminiAnalysis;
  try {
    analysis = await analyzeConversations(combinedText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[process-export] Gemini error:', err);
    return res.status(500).json({ error: `AI analysis failed: ${msg}` });
  }

  // Save to database
  try {
    await saveResults(supabase, userId, analysis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[process-export] DB write error:', err);
    return res.status(500).json({ error: `Failed to save results: ${msg}` });
  }

  return res.status(200).json({
    success: true,
    summary: {
      professionalContext: analysis.professionalContext,
      interestsCount: analysis.interests.length,
      entitiesCount: analysis.entities.length,
      anchorsCount: analysis.candidateAnchors.length,
    },
  });
}
