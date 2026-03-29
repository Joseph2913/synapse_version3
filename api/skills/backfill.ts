import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 120s — heavy Gemini assessment + generation + embeddings
export const maxDuration = 120;

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_CONTENT_CHARS = 30_000;
const MIN_CONTENT_LENGTH = 500;

// Tiered threshold: low-relevance sources need a higher bar to create a skill
function getSkillReadinessThreshold(anchorRelevance: number): number {
  return anchorRelevance < 0.5 ? 0.65 : 0.55;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

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

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface SourceRow {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  source_type: string | null;
  source_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AnchorInfo {
  label: string;
  entity_type: string;
  description: string | null;
}

interface AssessmentResult {
  generalizability: number;
  structuralDensity: number;
  instructionalRatio: number;
  anchorRelevance: number;
  anchorMatches: string[];
  proposedSkillTitle: string;
  proposedSkillTitleHuman: string;
  proposedDomain: string;
  extractableMethodology: string;
  transferableMethods: string[];
  contextDependencies: string[];
}

interface DeduplicationResult {
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  targetSkillName: string | null;
  rationale: string;
  topicOverlap: number;
  noveltyScore: number;
  proposedNameGeneralization: string | null;
}

interface GenerationResult {
  description: string;
  content: string;
  tags: string[];
}

interface ExistingSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  domain: string | null;
  source_ids: string[];
  source_count: number;
  content: string;
}

interface BatchDetail {
  sourceId: string;
  sourceTitle: string | null;
  sourceType: string | null;
  skillReadiness: number | null;
  action: string;
  skillName: string | null;
  // Populated in dry run mode for full visibility
  assessment?: AssessmentResult;
  deduplication?: DeduplicationResult;
  generatedContent?: GenerationResult | { content: string; description: string };
}

// ─── GEMINI HELPERS ───────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return response;
  }
  throw new Error('fetchWithRetry: exhausted retries');
}

async function callGeminiJSON<T>(
  systemPrompt: string,
  userContent: string,
  temperature: number = 0.1
): Promise<T> {
  const response = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');

  return JSON.parse(text) as T;
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
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

    const data = await response.json() as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? [];
  } catch (err) {
    console.warn('[skills/backfill] embedding generation failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── ASSESSMENT PIPELINE ──────────────────────────────────────────────────────

function computeSkillReadiness(assessment: AssessmentResult): number {
  // Hard floor: narrative content or structurally weak sources can't create skills
  // regardless of how relevant they are to the user's anchors
  if (assessment.instructionalRatio < 0.5 || assessment.structuralDensity < 0.5) {
    return 0;
  }
  return (
    assessment.instructionalRatio * 0.25 +
    assessment.generalizability * 0.25 +
    assessment.structuralDensity * 0.20 +
    assessment.anchorRelevance * 0.30
  );
}

async function assessSource(
  content: string,
  entities: Array<{ label: string; entity_type: string; description: string | null }>,
  metadata: Record<string, unknown> | null,
  anchors: AnchorInfo[]
): Promise<AssessmentResult> {
  const entitySummary = entities
    .map(e => `${e.entity_type}: ${e.label}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');

  const anchorSummary = anchors
    .map(a => `- ${a.label} (${a.entity_type})${a.description ? `: ${a.description}` : ''}`)
    .join('\n');

  const existingIR = metadata?.skill_candidate_checks
    ? (metadata.skill_candidate_checks as Record<string, unknown>).instructionalRatio
    : null;

  const systemPrompt = `You are a skill assessment engine for a personal knowledge graph system. Your job is to evaluate whether a source (a YouTube video transcript, meeting transcript, or document) contains extractable, reusable methodology that could be encoded as a structured Claude skill — specifically for THIS user, based on their declared interests and expertise (anchors).

A Claude skill is a SKILL.md file that teaches Claude how to perform a specific task or follow a specific methodology. Good skills contain: step-by-step processes, named frameworks, decision criteria, concrete techniques, or structured approaches that someone could apply repeatedly in different contexts.

Evaluate this source on four dimensions:

1. GENERALIZABILITY (0.0–1.0): Could someone with no knowledge of this specific project, client, or meeting use the methodology described here?
   - 0.9+ = Completely portable, no context needed (e.g., "3 rules for preventing AI hallucination")
   - 0.5–0.8 = Core methodology is portable but needs some context stripping
   - Below 0.5 = Heavily context-dependent (e.g., project status updates, client-specific decisions)

2. STRUCTURAL DENSITY (0.0–1.0): Does the content contain enumerable, structured knowledge?
   - 0.9+ = Explicit numbered steps, named framework, tiered approach, decision tree
   - 0.5–0.8 = Methodology is present but implicit, could be structured
   - Below 0.5 = Narrative or conversational, no clear structure to extract

3. INSTRUCTIONAL RATIO (0.0–1.0): What proportion of the content is actively teaching methodology vs. narrative, storytelling, status updates, or off-topic conversation?${existingIR ? ` (The source metadata includes a pre-computed instructionalRatio of ${existingIR} — use it as a reference but compute your own from the content.)` : ''}
   Content type calibration — apply these IR ranges carefully:
   - Pure tutorials, how-to guides, or step-by-step walkthroughs: 0.7–1.0
   - Structured frameworks or decision trees with explanation: 0.6–0.8
   - Interviews or talks where methodology is extracted but not the primary format: 0.4–0.6
   - Case studies, success stories, or business retrospectives: ALWAYS 0.1–0.4 (even if instructive in tone, narrative structure dominates)
   - Curated lists, "top 10" overviews, or roundups: ALWAYS 0.2–0.45 (breadth without depth)
   - Meeting transcripts, project updates, or status discussions: 0.1–0.3
   A source that tells a story about HOW something was done is NOT the same as a source that teaches how to DO it.

4. ANCHOR RELEVANCE (0.0–1.0): How relevant is this source's methodology to the user's declared interests and expertise (their "anchors")? This is the most important personalization signal.
   - 0.9+ = Directly addresses one or more of the user's core anchors (e.g., source about AI prompting techniques when user has "AI Prompting" and "Claude" anchors)
   - 0.6–0.8 = Tangentially related to user's anchors or addresses adjacent topics the user would benefit from
   - 0.3–0.5 = Weak connection — the methodology exists in a domain the user doesn't focus on, but could have some cross-domain utility
   - Below 0.3 = No meaningful connection to the user's interests (e.g., a source about currency trading when user focuses on AI and consulting)

THE USER'S ANCHORS (their declared areas of interest/expertise):
${anchorSummary || '(no anchors defined — score anchorRelevance based on general utility)'}

Also provide:
- anchorMatches: An array of the specific anchor labels that this source is relevant to (empty array if none)
- proposedSkillTitle: A kebab-case name for the skill — MUST be concept-based, not tool-specific or source-specific.
  GOOD: "ai-agent-orchestration", "context-window-management", "stakeholder-alignment-framework"
  BAD: "claude-code-workflow", "notion-database-setup", "rapido-growth-strategy" (tool/brand names belong in tags, not the skill name)
  The name should describe the transferable methodology, not the tool used or the company studied.
- proposedSkillTitleHuman: A human-readable title (e.g., "AI Agent Orchestration")
- proposedDomain: One of: ai-tooling, ai-prompting, consulting-methodology, change-management, financial-analysis, risk-management, sales-methodology, project-management, product-design, general
- extractableMethodology: A 1-2 sentence summary of what methodology could be extracted
- transferableMethods: An array of the specific techniques/steps that are portable
- contextDependencies: An array of things that would need to be stripped or generalized

Return your assessment as a JSON object with these exact keys: generalizability, structuralDensity, instructionalRatio, anchorRelevance, anchorMatches, proposedSkillTitle, proposedSkillTitleHuman, proposedDomain, extractableMethodology, transferableMethods, contextDependencies.`;

  const userContent = `SOURCE CONTENT (may be truncated):\n${content.slice(0, MAX_CONTENT_CHARS)}\n\nEXTRACTED ENTITIES:\n${entitySummary || '(no entities extracted)'}`;

  return callGeminiJSON<AssessmentResult>(systemPrompt, userContent, 0.1);
}

async function checkDeduplication(
  assessment: AssessmentResult,
  existingSkills: ExistingSkill[]
): Promise<DeduplicationResult> {
  if (existingSkills.length === 0) {
    return { action: 'CREATE', targetSkillName: null, rationale: 'No existing skills to compare against.', topicOverlap: 0, noveltyScore: 1, proposedNameGeneralization: null };
  }

  const existingList = existingSkills
    .map(s => {
      // Extract Methodology section for richer dedup signal beyond just the description
      const methodologyMatch = s.content.match(/##\s*Methodology\s*([\s\S]*?)(?=##|$)/i);
      const methodologySnippet = methodologyMatch
        ? methodologyMatch[1].trim().slice(0, 400)
        : s.content.slice(0, 400);
      return `- ${s.name}: "${s.title}" (domain: ${s.domain ?? 'general'}, sources: ${s.source_count})\n  Description: ${s.description}\n  Methodology (excerpt): ${methodologySnippet}`;
    })
    .join('\n\n');

  const systemPrompt = `You are comparing a new skill candidate against existing skills in a knowledge library.

Determine the best action:
1. CREATE — No existing skill covers this methodology. This is genuinely new ground.
2. UPDATE — An existing skill covers the same domain/topic and this source adds novel techniques or content. The novelty threshold scales by how mature the skill is:
   - skill has 1 source: 10% new content is enough to UPDATE
   - skill has 2–3 sources: 20% new content required
   - skill has 4+ sources: 30% new content required
3. SKIP — An existing skill already covers this methodology adequately and the new source adds nothing meaningful. Return the name of the skill that covers it. NOTE: even on SKIP the source will still be linked to that skill for attribution — SKIP means "no content update needed", not "discard".

ADDITIONAL RULE for UPDATE actions: If the skill being updated already has 2 or more sources (source_count ≥ 2), also evaluate whether its current name is still representative. If the name should be generalized to better reflect accumulated scope, return a proposedNameGeneralization field with the new kebab-case name; otherwise return null.

Return a JSON object with: action ("CREATE" | "UPDATE" | "SKIP"), targetSkillName (null for CREATE, skill name for UPDATE/SKIP), rationale (one sentence), topicOverlap (0.0–1.0), noveltyScore (0.0–1.0), proposedNameGeneralization (string | null — only relevant when action=UPDATE).`;


  const userContent = `NEW CANDIDATE:
- Title: ${assessment.proposedSkillTitle}
- Human Title: ${assessment.proposedSkillTitleHuman}
- Domain: ${assessment.proposedDomain}
- Methodology: ${assessment.extractableMethodology}
- Transferable methods: ${assessment.transferableMethods.join(', ')}

EXISTING SKILLS:
${existingList}`;

  return callGeminiJSON<DeduplicationResult>(systemPrompt, userContent, 0.1);
}

async function generateSkillContent(
  source: SourceRow,
  content: string,
  entities: Array<{ label: string; entity_type: string; description: string | null }>,
  assessment: AssessmentResult
): Promise<GenerationResult> {
  const entitySummary = entities
    .map(e => `${e.entity_type}: ${e.label}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n');

  const createdDate = source.created_at ? new Date(source.created_at).toISOString().split('T')[0] : 'unknown';

  const systemPrompt = `You are generating a Claude skill from a knowledge source. A Claude skill is a structured SKILL.md file that teaches Claude a specific methodology, framework, or technique.

Generate the skill content following this exact structure:

## Context
{When and why to use this skill. What problem it solves. Who benefits from it. Write 2-3 sentences.}

## Methodology
{The core process, framework, or technique. Structure as numbered steps, principles, or decision criteria. Write in imperative form ("Do X", "Check Y", "If Z then..."). Be specific and actionable. Strip all project-specific context — make this universally applicable. This is the most important section.}

## Examples
{1-2 concrete examples showing the methodology applied. Derived from the source content but generalized.}

## Synapse Source Attribution
This skill was auto-generated from the following Synapse knowledge source:
- **${source.title || 'Untitled Source'}** (${source.source_type || 'unknown'}, ${createdDate})
  - Source ID: \`${source.id}\`
  - To retrieve the full transcript: use \`get_meeting_transcript\` or \`get_source_content\` with source_id \`${source.id}\` via the Synapse MCP
  - To explore entities from this source: use \`search_entities\` with source_id \`${source.id}\`
  - To find related sources: use \`get_related_sources\` with source_id \`${source.id}\`

Also generate:
- A triggering description: a paragraph that tells Claude WHEN to use this skill. Be slightly "pushy" — include specific keywords, contexts, and task types that should activate it. This should be compelling enough that Claude picks this skill when relevant.
- A tags array: 3-5 relevant keywords.

Return a JSON object with these exact keys: description, content (the full skill body as described above), tags (string array).`;

  const userContent = `SOURCE TITLE: ${source.title || 'Untitled'}
SOURCE TYPE: ${source.source_type || 'unknown'}
ASSESSMENT:
- Domain: ${assessment.proposedDomain}
- Extractable methodology: ${assessment.extractableMethodology}
- Transferable methods: ${assessment.transferableMethods.join(', ')}
- Context dependencies to strip: ${assessment.contextDependencies.join(', ')}

SOURCE CONTENT (may be truncated):
${content.slice(0, MAX_CONTENT_CHARS)}

EXTRACTED ENTITIES:
${entitySummary || '(no entities)'}`;

  return callGeminiJSON<GenerationResult>(systemPrompt, userContent, 0.2);
}

async function generateUpdateContent(
  existingSkill: ExistingSkill,
  source: SourceRow,
  content: string,
  assessment: AssessmentResult
): Promise<{ content: string; description: string }> {
  const createdDate = source.created_at ? new Date(source.created_at).toISOString().split('T')[0] : 'unknown';

  const systemPrompt = `You are updating an existing Claude skill with new content from an additional source.

Merge the new content into the existing skill:
1. Add genuinely new techniques/steps to the Methodology section
2. Add new examples to the Examples section if the new source provides good ones
3. Append the new source to the Synapse Source Attribution section:
   - **${source.title || 'Untitled Source'}** (${source.source_type || 'unknown'}, ${createdDate})
     - Source ID: \`${source.id}\`
     - To retrieve the full transcript: use \`get_meeting_transcript\` or \`get_source_content\` with source_id \`${source.id}\` via the Synapse MCP
4. Do NOT remove or rewrite existing content — only add and refine
5. If the new source corrects something in the existing skill, apply the correction with a brief note

Return a JSON object with: content (the updated full body), description (updated if needed, otherwise return the existing one unchanged).`;

  const userContent = `EXISTING SKILL:
- Name: ${existingSkill.name}
- Title: ${existingSkill.title}
- Current content:
${existingSkill.content}
- Current source count: ${existingSkill.source_count}

NEW SOURCE:
- Title: ${source.title || 'Untitled'}
- Type: ${source.source_type || 'unknown'}
- New methods identified: ${assessment.transferableMethods.join(', ')}

NEW SOURCE CONTENT (may be truncated):
${content.slice(0, MAX_CONTENT_CHARS)}`;

  return callGeminiJSON<{ content: string; description: string }>(systemPrompt, userContent, 0.2);
}

// ─── SOURCE MARKING ───────────────────────────────────────────────────────────

async function markSource(
  supabase: ReturnType<typeof getSupabase>,
  sourceId: string,
  result: string,
  skillName: string | null,
  existingMetadata: Record<string, unknown> | null
): Promise<void> {
  const updatedMetadata = {
    ...(existingMetadata ?? {}),
    skill_backfill_status: 'processed',
    skill_backfill_at: new Date().toISOString(),
    skill_backfill_result: result,
    skill_backfill_skill_name: skillName,
  };

  await supabase
    .from('knowledge_sources')
    .update({ metadata: updatedMetadata })
    .eq('id', sourceId);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!userId && !isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse params — POST body or GET query string (Vercel crons use GET)
  const body = req.method === 'POST' ? (req.body ?? {}) : {};
  const query = req.query ?? {};
  const batchSize = Math.min(Math.max(parseInt(body.batchSize || query.batch_size as string) || 10, 1), 20);
  const page = Math.max(parseInt(body.page || query.page as string) || 0, 0);
  const sourceTypeFilter: string | undefined = body.sourceType || (query.source_type as string) || undefined;
  const dryRun: boolean = body.dryRun === true || query.dry_run === 'true';

  const supabase = getSupabase();
  const startTime = Date.now();
  const details: BatchDetail[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let deferred = 0;

  // ─── Fetch candidate sources ────────────────────────────────────────────────
  // Priority: YouTube skill_candidate=true → YouTube unchecked → Meeting skill_candidate=true → Meeting unchecked → Document
  // We fetch more than batchSize and filter, since not all will qualify

  let sourceQuery = supabase
    .from('knowledge_sources')
    .select('id, user_id, title, content, source_type, source_url, metadata, created_at')
    .is('metadata->skill_backfill_status', null)
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
    .range(page * batchSize * 3, (page + 1) * batchSize * 3 - 1);

  if (userId) {
    sourceQuery = sourceQuery.eq('user_id', userId);
  }

  if (sourceTypeFilter) {
    sourceQuery = sourceQuery.eq('source_type', sourceTypeFilter);
  }

  const { data: rawSources, error: fetchError } = await sourceQuery;

  if (fetchError) {
    return res.status(500).json({ error: 'Failed to fetch sources', detail: fetchError.message });
  }

  // Safety filter: remove any sources that already have a backfill status
  // (in case the JSON path filter doesn't work on all PostgREST versions)
  const filteredSources = (rawSources ?? []).filter(s => {
    const meta = s.metadata as Record<string, unknown> | null;
    return !meta?.skill_backfill_status;
  });

  if (filteredSources.length === 0) {
    // Count remaining
    let countQ = supabase
      .from('knowledge_sources')
      .select('id', { count: 'exact', head: true })
      .is('metadata->skill_backfill_status', null)
      .not('content', 'is', null);
    if (userId) countQ = countQ.eq('user_id', userId);
    const { count } = await countQ;

    return res.status(200).json({
      success: true,
      batch: { processed: 0, created: 0, updated: 0, skipped: 0, deferred: 0, details: [] },
      remaining: count ?? 0,
      stats: { totalSources: 0, totalProcessed: 0, totalSkillsCreated: 0, totalSkillsUpdated: 0 },
    });
  }

  // Sort by priority: YouTube first, then Meeting, then others
  // Within each type, skill_candidate=true first, then by instructionalRatio desc
  const sources = (filteredSources as SourceRow[]).sort((a, b) => {
    const typeOrder: Record<string, number> = { YouTube: 0, Meeting: 1, Document: 2 };
    const aType = typeOrder[a.source_type ?? ''] ?? 3;
    const bType = typeOrder[b.source_type ?? ''] ?? 3;
    if (aType !== bType) return aType - bType;

    const aCand = (a.metadata as Record<string, unknown>)?.skill_candidate === true ? 0 : 1;
    const bCand = (b.metadata as Record<string, unknown>)?.skill_candidate === true ? 0 : 1;
    if (aCand !== bCand) return aCand - bCand;

    const aIR = ((a.metadata as Record<string, unknown>)?.skill_candidate_checks as Record<string, unknown>)?.instructionalRatio as number ?? 0;
    const bIR = ((b.metadata as Record<string, unknown>)?.skill_candidate_checks as Record<string, unknown>)?.instructionalRatio as number ?? 0;
    return bIR - aIR;
  }).slice(0, batchSize);

  // ─── Fetch user's anchors for relevance scoring ──────────────────────────────

  const targetUserId = userId ?? sources[0]?.user_id;
  let userAnchors: AnchorInfo[] = [];

  if (targetUserId) {
    const { data: anchorNodes } = await supabase
      .from('knowledge_nodes')
      .select('label, entity_type, description')
      .eq('user_id', targetUserId)
      .eq('is_anchor', true)
      .order('label');

    userAnchors = (anchorNodes ?? []) as AnchorInfo[];
  }

  // ─── Fetch existing skills for deduplication ────────────────────────────────

  let existingSkills: ExistingSkill[] = [];

  if (targetUserId) {
    const { data: skills } = await supabase
      .from('knowledge_skills')
      .select('id, name, title, description, domain, source_ids, source_count, content')
      .eq('user_id', targetUserId)
      .in('status', ['draft', 'active']);

    existingSkills = (skills ?? []) as ExistingSkill[];
  }

  // ─── Process each source ────────────────────────────────────────────────────

  for (const source of sources) {
    // Time budget check — leave 10s buffer
    if (Date.now() - startTime > 105_000) {
      details.push({
        sourceId: source.id,
        sourceTitle: source.title,
        sourceType: source.source_type,
        skillReadiness: null,
        action: 'deferred',
        skillName: null,
      });
      deferred++;
      await markSource(supabase, source.id, 'deferred', null, source.metadata);
      continue;
    }

    try {
      const metadata = (source.metadata ?? {}) as Record<string, unknown>;

      // ── Pre-filter: content length ──────────────────────────────────────────
      if (!source.content || source.content.length < MIN_CONTENT_LENGTH) {
        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness: null,
          action: 'skipped_no_content',
          skillName: null,
        });
        skipped++;
        if (!dryRun) await markSource(supabase, source.id, 'skipped_no_content', null, source.metadata);
        continue;
      }

      // ── Pre-filter: chunk count ─────────────────────────────────────────────
      const { count: chunkCount } = await supabase
        .from('source_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('source_id', source.id);

      if (!chunkCount || chunkCount === 0) {
        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness: null,
          action: 'skipped_no_chunks',
          skillName: null,
        });
        skipped++;
        if (!dryRun) await markSource(supabase, source.id, 'skipped_no_chunks', null, source.metadata);
        continue;
      }

      // ── Pre-filter: low instructionalRatio with confirmed skill_candidate=false ──
      const candidateChecks = metadata.skill_candidate_checks as Record<string, unknown> | undefined;
      if (
        metadata.skill_candidate === false &&
        candidateChecks?.instructionalRatio != null &&
        (candidateChecks.instructionalRatio as number) < 0.35
      ) {
        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness: null,
          action: 'skipped_below_threshold',
          skillName: null,
        });
        skipped++;
        if (!dryRun) await markSource(supabase, source.id, 'skipped_below_threshold', null, source.metadata);
        continue;
      }

      // ── Step 2: Fetch entities ──────────────────────────────────────────────
      const { data: entities } = await supabase
        .from('knowledge_nodes')
        .select('label, entity_type, description')
        .eq('source_id', source.id)
        .order('entity_type')
        .order('label');

      const entityList = (entities ?? []) as Array<{ label: string; entity_type: string; description: string | null }>;

      // ── Step 3: Three-signal assessment (Gemini) ────────────────────────────
      const assessment = await assessSource(source.content, entityList, source.metadata, userAnchors);
      const skillReadiness = computeSkillReadiness(assessment);

      if (skillReadiness < getSkillReadinessThreshold(assessment.anchorRelevance)) {
        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness,
          action: 'skipped_below_threshold',
          skillName: null,
        });
        skipped++;
        if (!dryRun) await markSource(supabase, source.id, 'skipped_below_threshold', null, source.metadata);
        continue;
      }

      // ── Step 5: Deduplication ───────────────────────────────────────────────
      const dedup = await checkDeduplication(assessment, existingSkills);

      if (dedup.action === 'SKIP') {
        // Even on SKIP, link this source to the skill for attribution (no content update)
        if (!dryRun && dedup.targetSkillName) {
          const targetSkill = existingSkills.find(s => s.name === dedup.targetSkillName);
          if (targetSkill && !targetSkill.source_ids.includes(source.id)) {
            await supabase
              .from('knowledge_skills')
              .update({
                source_ids: [...targetSkill.source_ids, source.id],
                source_count: targetSkill.source_count + 1,
              })
              .eq('name', dedup.targetSkillName)
              .eq('user_id', source.user_id);
            // Update local cache so subsequent dedup sees the updated count
            targetSkill.source_ids = [...targetSkill.source_ids, source.id];
            targetSkill.source_count = targetSkill.source_count + 1;
          }
        }
        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness,
          action: 'skipped_duplicate',
          skillName: dedup.targetSkillName,
        });
        skipped++;
        if (!dryRun) await markSource(supabase, source.id, 'skipped_duplicate', dedup.targetSkillName, source.metadata);
        continue;
      }

      // ── Step 6: Generate or Update ──────────────────────────────────────────

      if (dedup.action === 'CREATE') {
        const generation = await generateSkillContent(source, source.content, entityList, assessment);

        if (dryRun) {
          details.push({
            sourceId: source.id,
            sourceTitle: source.title,
            sourceType: source.source_type,
            skillReadiness,
            action: 'dry_run_create',
            skillName: assessment.proposedSkillTitle,
            assessment,
            deduplication: dedup,
            generatedContent: generation,
          });
          created++;
          // Track for in-batch dedup even in dry run
          existingSkills.push({
            id: '',
            name: assessment.proposedSkillTitle,
            title: assessment.proposedSkillTitleHuman,
            description: generation.description,
            domain: assessment.proposedDomain,
            source_ids: [source.id],
            source_count: 1,
            content: generation.content,
          });
          continue;
        }

        // Insert the skill
        const { error: insertError } = await supabase
          .from('knowledge_skills')
          .insert({
            user_id: source.user_id,
            name: assessment.proposedSkillTitle,
            title: assessment.proposedSkillTitleHuman,
            description: generation.description,
            domain: assessment.proposedDomain,
            tags: generation.tags,
            content: generation.content,
            source_ids: [source.id],
            source_count: 1,
            confidence: skillReadiness,
            instructional_ratio: assessment.instructionalRatio,
            generalizability: assessment.generalizability,
            structural_density: assessment.structuralDensity,
            status: 'draft',
          });

        if (insertError) {
          // Handle unique constraint — try with numeric suffix
          if (insertError.code === '23505') {
            const suffixedName = `${assessment.proposedSkillTitle}-${Date.now().toString(36).slice(-4)}`;
            const { error: retryError } = await supabase
              .from('knowledge_skills')
              .insert({
                user_id: source.user_id,
                name: suffixedName,
                title: assessment.proposedSkillTitleHuman,
                description: generation.description,
                domain: assessment.proposedDomain,
                tags: generation.tags,
                content: generation.content,
                source_ids: [source.id],
                source_count: 1,
                confidence: skillReadiness,
                instructional_ratio: assessment.instructionalRatio,
                generalizability: assessment.generalizability,
                structural_density: assessment.structuralDensity,
                status: 'draft',
              });

            if (retryError) {
              throw new Error(`Insert failed after retry: ${retryError.message}`);
            }

            // Step 7: Embedding
            const embedding = await generateEmbedding(generation.description);
            if (embedding.length > 0) {
              await supabase
                .from('knowledge_skills')
                .update({ embedding })
                .eq('name', suffixedName)
                .eq('user_id', source.user_id);
            }

            existingSkills.push({
              id: '',
              name: suffixedName,
              title: assessment.proposedSkillTitleHuman,
              description: generation.description,
              domain: assessment.proposedDomain,
              source_ids: [source.id],
              source_count: 1,
              content: generation.content,
            });

            details.push({
              sourceId: source.id,
              sourceTitle: source.title,
              sourceType: source.source_type,
              skillReadiness,
              action: 'created',
              skillName: suffixedName,
            });
            created++;
            await markSource(supabase, source.id, 'created', suffixedName, source.metadata);
            continue;
          }
          throw new Error(`Insert failed: ${insertError.message}`);
        }

        // Step 7: Embedding
        const embedding = await generateEmbedding(generation.description);
        if (embedding.length > 0) {
          await supabase
            .from('knowledge_skills')
            .update({ embedding })
            .eq('name', assessment.proposedSkillTitle)
            .eq('user_id', source.user_id);
        }

        // Track in existingSkills for dedup within this batch
        existingSkills.push({
          id: '',
          name: assessment.proposedSkillTitle,
          title: assessment.proposedSkillTitleHuman,
          description: generation.description,
          domain: assessment.proposedDomain,
          source_ids: [source.id],
          source_count: 1,
          content: generation.content,
        });

        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness,
          action: 'created',
          skillName: assessment.proposedSkillTitle,
        });
        created++;
        await markSource(supabase, source.id, 'created', assessment.proposedSkillTitle, source.metadata);

      } else if (dedup.action === 'UPDATE') {
        const targetSkill = existingSkills.find(s => s.name === dedup.targetSkillName);
        if (!targetSkill) {
          console.warn(`[skills/backfill] UPDATE target "${dedup.targetSkillName}" not found, falling back to CREATE`);
          details.push({
            sourceId: source.id,
            sourceTitle: source.title,
            sourceType: source.source_type,
            skillReadiness,
            action: 'deferred',
            skillName: null,
          });
          deferred++;
          if (!dryRun) await markSource(supabase, source.id, 'deferred', null, source.metadata);
          continue;
        }

        const updateResult = await generateUpdateContent(targetSkill, source, source.content, assessment);

        if (dryRun) {
          details.push({
            sourceId: source.id,
            sourceTitle: source.title,
            sourceType: source.source_type,
            skillReadiness,
            action: 'dry_run_update',
            skillName: targetSkill.name,
            assessment,
            deduplication: dedup,
            generatedContent: updateResult,
          });
          updated++;
          continue;
        }

        const newSourceIds = [...targetSkill.source_ids, source.id];
        const newSourceCount = targetSkill.source_count + 1;

        const { error: updateError } = await supabase
          .from('knowledge_skills')
          .update({
            content: updateResult.content,
            description: updateResult.description,
            source_ids: newSourceIds,
            source_count: newSourceCount,
            updated_at: new Date().toISOString(),
          })
          .eq('name', targetSkill.name)
          .eq('user_id', source.user_id);

        if (updateError) {
          throw new Error(`Update failed: ${updateError.message}`);
        }

        // Re-embed with updated description
        const embedding = await generateEmbedding(updateResult.description);
        if (embedding.length > 0) {
          await supabase
            .from('knowledge_skills')
            .update({ embedding })
            .eq('name', targetSkill.name)
            .eq('user_id', source.user_id);
        }

        // Update local cache
        targetSkill.content = updateResult.content;
        targetSkill.description = updateResult.description;
        targetSkill.source_ids = newSourceIds;
        targetSkill.source_count = newSourceCount;

        details.push({
          sourceId: source.id,
          sourceTitle: source.title,
          sourceType: source.source_type,
          skillReadiness,
          action: 'updated',
          skillName: targetSkill.name,
        });
        updated++;
        await markSource(supabase, source.id, 'updated', targetSkill.name, source.metadata);
      }

      // Small delay between Gemini calls to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[skills/backfill] Error processing source ${source.id}:`, msg);

      details.push({
        sourceId: source.id,
        sourceTitle: source.title,
        sourceType: source.source_type,
        skillReadiness: null,
        action: 'deferred',
        skillName: null,
      });
      deferred++;

      try {
        await markSource(supabase, source.id, 'deferred', null, source.metadata);
      } catch { /* ignore marking failure */ }
    }
  }

  // ─── Count remaining ────────────────────────────────────────────────────────

  let remainingQuery = supabase
    .from('knowledge_sources')
    .select('id', { count: 'exact', head: true })
    .is('metadata->skill_backfill_status', null)
    .not('content', 'is', null);

  if (userId) remainingQuery = remainingQuery.eq('user_id', userId);
  const { count: remaining } = await remainingQuery;

  // Stats
  let statsQuery = supabase
    .from('knowledge_skills')
    .select('id', { count: 'exact', head: true });
  if (targetUserId) statsQuery = statsQuery.eq('user_id', targetUserId);
  const { count: totalSkills } = await statsQuery;

  return res.status(200).json({
    success: true,
    batch: {
      processed: details.length,
      created,
      updated,
      skipped,
      deferred,
      details,
    },
    remaining: remaining ?? 0,
    stats: {
      totalSources: filteredSources.length,
      totalProcessed: details.length,
      totalSkillsCreated: created,
      totalSkillsUpdated: updated,
      totalSkillsInLibrary: totalSkills ?? 0,
    },
    durationMs: Date.now() - startTime,
  });
}
