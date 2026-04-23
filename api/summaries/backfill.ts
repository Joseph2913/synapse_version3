import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Allow up to 60s on Vercel Pro
export const maxDuration = 60;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── AUTH (same pattern as api/youtube/process.ts) ─────────────────────────────

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

// ─── INLINE SUMMARIZATION HELPERS (duplicated from src/utils/summarize.ts) ─────

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

function clampSummary(text: string, maxLength: number = 350): string {
  const cleaned = stripMarkdown(text).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclaim = truncated.lastIndexOf('!');
  const lastBoundary = Math.max(lastPeriod, lastQuestion, lastExclaim);
  if (lastBoundary > maxLength * 0.5) {
    return truncated.slice(0, lastBoundary + 1);
  }
  return truncated.trimEnd() + '...';
}

function truncateAsSummary(content: string, maxChars: number = 300): string {
  const cleaned = stripMarkdown(content).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return clampSummary(cleaned, maxChars);
}

function extractMetadataSummary(
  metadata: Record<string, unknown>
): string | null {
  const candidates = [
    metadata.description,
    metadata.og_description,
    metadata.abstract,
    metadata.summary,
    metadata.excerpt,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 30);
  const first = candidates[0];
  if (first) return clampSummary(first);
  return null;
}

function extractPreamble(content: string): string | null {
  const firstHeadingIndex = content.search(/^#{1,3}\s/m);
  if (firstHeadingIndex > 20) {
    const preamble = content.slice(0, firstHeadingIndex).trim();
    const sentences = preamble.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length >= 1 && sentences.length <= 4 && preamble.length <= 500) {
      return clampSummary(preamble);
    }
  }
  return null;
}

function extractLabelledSection(content: string): string | null {
  const summaryHeadingPattern =
    /^#{1,3}\s*(Summary|Overview|Key Takeaways|Executive Summary|TLDR)\s*$/im;
  const match = content.match(summaryHeadingPattern);
  if (match && match.index !== undefined) {
    const afterHeading = content.slice(match.index + match[0].length).trim();
    const nextHeading = afterHeading.search(/^#{1,3}\s/m);
    const sectionBody =
      nextHeading > 0
        ? afterHeading.slice(0, nextHeading).trim()
        : afterHeading.slice(0, 500).trim();
    if (sectionBody.length > 20) {
      return clampSummary(sectionBody);
    }
  }
  return null;
}

function extractStructuredSummary(
  content: string,
  metadata: Record<string, unknown> | null
): string | null {
  const provider = ((metadata?.provider as string) || '').toLowerCase();
  if (['circleback', 'otter', 'fireflies', 'meetgeek'].includes(provider)) {
    const labelled = extractLabelledSection(content);
    if (labelled) return labelled;
    const preamble = extractPreamble(content);
    if (preamble) return preamble;
  }

  const preamble = extractPreamble(content);
  if (preamble) return preamble;

  const labelled = extractLabelledSection(content);
  if (labelled) return labelled;

  return null;
}

async function generateSummaryViaGemini(
  content: string,
  sourceType: string | null
): Promise<string | null> {
  const truncatedContent =
    content.length > 8000
      ? content.slice(0, 8000) + '\n\n[Content truncated for summarization]'
      : content;

  const sourceLabel = sourceType || 'content';

  const systemPrompt = `You are a concise summarizer. Given a piece of ${sourceLabel.toLowerCase()}, produce a 2–3 sentence summary that describes what this content contains. Rules:
- Be factual and descriptive, not analytical or evaluative.
- Describe the topics covered, not what the reader should take away.
- Use plain, professional language.
- Do not start with "This ${sourceLabel.toLowerCase()}..." — vary your openings.
- Do not reference the format ("this transcript", "this document") — summarize the substance.
- Maximum 300 characters.
- Return ONLY the summary text, no preamble, no quotes, no formatting.`;

  try {
    const response = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: truncatedContent }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 150,
          },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text || text.trim().length === 0) return null;
    const clamped = clampSummary(text.trim());
    // Reject obviously-truncated Gemini outputs. Real summaries are 2-3
    // sentences (~150-300 chars). Anything under ~80 chars is almost always
    // a cut-off response and should be rejected so the backfill cron can
    // retry on the next tick.
    if (clamped.length < 80) return null;
    return clamped;
  } catch {
    return null;
  }
}

async function resolveSummaryForSource(
  sourceType: string | null,
  content: string | null,
  metadata: Record<string, unknown> | null
): Promise<{ summary: string; source: string } | null> {
  if (!content || content.trim().length === 0) return null;

  const wordCount = content.trim().split(/\s+/).length;

  // Tier 1: Short content — truncate
  if (wordCount <= 150) {
    return { summary: truncateAsSummary(content, 300), source: 'truncated' };
  }

  // Tier 2: Structured sources (meetings)
  if (sourceType === 'Meeting') {
    const extracted = extractStructuredSummary(content, metadata);
    if (extracted) return { summary: extracted, source: 'extracted' };
  }

  // Tier 3: Metadata
  if (metadata) {
    const metaSummary = extractMetadataSummary(metadata);
    if (metaSummary) return { summary: metaSummary, source: 'extracted' };
  }

  // Tier 4: Gemini generation
  const generated = await generateSummaryViaGemini(content, sourceType);
  if (generated) return { summary: generated, source: 'generated' };

  // Tier 5: Fallback truncation
  return { summary: truncateAsSummary(content, 300), source: 'truncated' };
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify auth
  const { userId, isCron } = await verifyUserAuth(req);
  if (!userId && !isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse params
  const batchSize = Math.min(
    parseInt((req.query.batch_size as string) || '10', 10),
    25
  );
  const sourceTypeFilter = req.query.source_type as string | undefined;

  const supabase = getSupabase();

  // Cap retries so we don't re-burn Gemini quota on genuinely unsummarizable
  // content. Tracked in metadata.summary_retry_count to avoid a schema change.
  const MAX_SUMMARY_RETRIES = 3;

  // Fetch sources needing summaries: either never summarized (summary IS NULL)
  // or stuck on a truncated stub from a prior failed Gemini call.
  let query = supabase
    .from('knowledge_sources')
    .select('id, user_id, title, content, source_type, summary_source, metadata')
    .or('summary.is.null,summary_source.eq.truncated')
    .order('created_at', { ascending: false })
    .limit(batchSize);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  if (sourceTypeFilter) {
    query = query.eq('source_type', sourceTypeFilter);
  }

  const { data: rawSources, error: fetchError } = await query;

  if (fetchError) {
    return res.status(500).json({
      error: 'Failed to fetch sources',
      detail: fetchError.message,
    });
  }

  // Filter out truncated rows that have already exhausted their retry budget.
  const sources = (rawSources ?? []).filter((s: Record<string, unknown>) => {
    if (s.summary_source !== 'truncated') return true;
    const meta = (s.metadata as Record<string, unknown> | null) ?? {};
    const retries = Number(meta['summary_retry_count'] ?? 0);
    return retries < MAX_SUMMARY_RETRIES;
  });

  if (!sources || sources.length === 0) {
    return res.status(200).json({ processed: 0, remaining: 0, errors: [] });
  }

  // Process batch
  const errors: string[] = [];
  let processed = 0;

  for (const source of sources) {
    try {
      const priorMetadata = (source.metadata as Record<string, unknown> | null) ?? {};
      const priorRetries = Number(priorMetadata['summary_retry_count'] ?? 0);
      const isRetry = source.summary_source === 'truncated';

      const result = await resolveSummaryForSource(
        source.source_type,
        source.content,
        priorMetadata
      );

      if (result) {
        // If this is a retry AND we fell back to truncated again, bump the
        // retry counter so the source eventually ages out of the backfill
        // queue instead of spinning every cron tick.
        const nextMetadata =
          isRetry && result.source === 'truncated'
            ? { ...priorMetadata, summary_retry_count: priorRetries + 1 }
            : priorMetadata;

        const { error: updateError } = await supabase
          .from('knowledge_sources')
          .update({
            summary: result.summary,
            summary_source: result.source,
            metadata: nextMetadata,
          })
          .eq('id', source.id);

        if (updateError) {
          errors.push(`${source.id}: Update failed — ${updateError.message}`);
        } else {
          processed++;
        }
      } else {
        // Content was empty/null — nothing to summarize
        processed++;
      }

      // Rate limit between Gemini calls
      if (result?.source === 'generated') {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (err) {
      errors.push(
        `${source.id}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }

  // Count remaining (null or truncated-under-cap). Use a server-side count for
  // nulls and keep it simple — truncated-under-cap count is only advisory.
  let remainingQuery = supabase
    .from('knowledge_sources')
    .select('id', { count: 'exact', head: true })
    .or('summary.is.null,summary_source.eq.truncated');
  if (userId) remainingQuery = remainingQuery.eq('user_id', userId);
  const { count: remaining } = await remainingQuery;

  return res.status(200).json({
    processed,
    remaining: remaining || 0,
    errors,
  });
}
