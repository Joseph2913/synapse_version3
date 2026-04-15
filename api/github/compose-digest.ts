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

const MAX_ITEMS_PER_BATCH = 3;
const MAX_RAW_LOG_CHARS = 80_000;
const MAX_DIFF_CHARS = 50_000;

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  repo_id: string;
  digest_date: string;
  commit_count: number;
  commit_range: string;
  authors: string[];
  raw_log: string;
  status: string;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  digest_content: string | null;
}

interface TrackedRepo {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  display_name: string | null;
  repo_url: string;
  custom_instructions: string | null;
  github_token: string | null;
}

interface CommitFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

interface CommitDetail {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  files?: CommitFile[];
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

// ─── GITHUB API ────────────────────────────────────────────────────────────────

async function fetchCommitDetail(
  owner: string,
  repo: string,
  sha: string,
  token: string | null
): Promise<CommitDetail | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Synapse-Knowledge-Graph',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) return null;
    return await response.json() as CommitDetail;
  } catch {
    return null;
  }
}

// ─── DIFF BUILDER ──────────────────────────────────────────────────────────────

async function buildDiffContent(
  owner: string,
  repo: string,
  rawLog: string,
  token: string | null
): Promise<string> {
  // Extract 7-char SHAs from raw_log entries like [abc1234]
  const shaMatches = [...rawLog.matchAll(/\[([a-f0-9]{7})\]/g)];
  const shas = [...new Set(shaMatches.map(m => m[1]))].slice(0, 20);

  if (shas.length === 0) return '';

  const diffParts: string[] = [];
  let totalChars = 0;

  for (const sha of shas) {
    if (totalChars >= MAX_DIFF_CHARS) break;

    const detail = await fetchCommitDetail(owner, repo, sha, token);
    if (!detail) continue;

    const message = detail.commit.message.split('\n')[0];
    let commitBlock = `### Commit ${sha}: ${message}\n`;

    if (detail.files && detail.files.length > 0) {
      for (const file of detail.files) {
        const patchText = file.patch
          ? file.patch.slice(0, 2000)
          : `[no patch — ${file.additions} additions, ${file.deletions} deletions]`;

        commitBlock += `\n**${file.filename}** (${file.status}, +${file.additions} -${file.deletions})\n`;
        commitBlock += '```\n' + patchText + '\n```\n';
      }
    }

    diffParts.push(commitBlock);
    totalChars += commitBlock.length;
  }

  return diffParts.join('\n').slice(0, MAX_DIFF_CHARS);
}

// ─── GEMINI ────────────────────────────────────────────────────────────────────

function buildDigestPrompt(
  item: QueueItem,
  repo: TrackedRepo,
  diffContent: string
): string {
  const displayName = repo.display_name ?? `${repo.owner}/${repo.repo}`;
  const repoUrl = repo.repo_url ?? `https://github.com/${repo.owner}/${repo.repo}`;
  const rawLog = item.raw_log.slice(0, MAX_RAW_LOG_CHARS);
  const authors = item.authors.join(', ');
  const customBlock = repo.custom_instructions
    ? `\n${repo.custom_instructions}\n`
    : '';

  return `You are analysing code changes from a GitHub repository for a personal knowledge graph system.

Repository: ${displayName} (${repoUrl})
Branch: ${repo.branch}
Date: ${item.digest_date}
Commits: ${item.commit_count}
Authors: ${authors}

Below are the commit messages and code diffs from this period.

Your job is to write a development digest that a knowledge extraction system will process. The extraction system looks for these entity types: Person, Organization, Technology, Product, Project, Decision, Insight, Lesson, Action, Risk, Goal, Concept, Topic.

Structure your digest with these sections:
- **Summary**: 2-3 sentence overview of what happened in this period
- **What Was Built**: Features, capabilities, or components added or changed. Plain language, not code jargon.
- **Decisions Made**: Technical or design decisions visible from the changes. State what was chosen and, if inferable, why.
- **Problems Solved**: Bug fixes, workarounds, or issues resolved. State what was broken and how it was fixed.
- **Technologies and Patterns**: Tools, libraries, APIs, or design patterns introduced or used significantly.
- **People**: Who contributed and what they worked on.
- **Open Work**: Anything that appears in progress or incomplete based on the changes.

Guidelines:
- Write in plain language. Explain what code changes mean, not what files changed.
- Be specific. "Added user authentication" is better than "updated auth files".
- If you can infer the reasoning behind a change from the commit message or diff context, include it.
- If a section has nothing meaningful, omit it entirely.
- Keep the total digest under 2000 words.
${customBlock}
--- COMMIT LOG ---
${rawLog}

--- CODE DIFFS ---
${diffContent || '(no diffs available)'}`;
}

async function callGemini(prompt: string): Promise<{ text: string | null; status: number }> {
  const response = await fetch(
    `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    return { text: null, status: response.status };
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return { text, status: 200 };
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) return res.status(401).json({ error: 'Unauthorized' });

  const startTime = Date.now();
  const supabase = getSupabase();

  const summary = {
    itemsProcessed: 0,
    itemsSucceeded: 0,
    itemsFailed: 0,
    itemsRetrying: 0,
    errors: [] as string[],
  };

  try {
    // Fetch pending queue items — scope to requesting user when user-triggered
    let queueQuery = supabase
      .from('github_ingestion_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (!isCron && userId) {
      queueQuery = queueQuery.eq('user_id', userId);
    }

    const { data: items, error: queueError } = await queueQuery;

    if (queueError) {
      return res.status(500).json({ error: queueError.message });
    }

    if (!items || items.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No pending items',
        ...summary,
        duration_ms: Date.now() - startTime,
      });
    }

    for (const rawItem of items) {
      const item = rawItem as QueueItem;
      const itemLabel = `queue:${item.id}`;
      summary.itemsProcessed++;

      // Mark as composing_digest
      await supabase
        .from('github_ingestion_queue')
        .update({ status: 'composing_digest' })
        .eq('id', item.id);

      try {
        // Fetch repo info
        const { data: repoData, error: repoError } = await supabase
          .from('github_tracked_repos')
          .select('id, owner, repo, branch, display_name, repo_url, custom_instructions, github_token')
          .eq('id', item.repo_id)
          .maybeSingle();

        if (repoError || !repoData) {
          const msg = repoError?.message ?? 'Repo not found';
          console.error(`[compose-digest] Repo fetch failed for ${itemLabel}:`, msg);
          await supabase
            .from('github_ingestion_queue')
            .update({
              status: 'failed',
              error_message: `Repo fetch failed: ${msg}`,
            })
            .eq('id', item.id);
          summary.itemsFailed++;
          summary.errors.push(`${itemLabel}: ${msg}`);
          continue;
        }

        const repo = repoData as TrackedRepo;
        const repoLabel = `${repo.owner}/${repo.repo}`;

        // Build diff content from GitHub
        let diffContent = '';
        try {
          diffContent = await buildDiffContent(repo.owner, repo.repo, item.raw_log, repo.github_token);
        } catch (diffErr) {
          const msg = diffErr instanceof Error ? diffErr.message : String(diffErr);
          console.warn(`[compose-digest] Diff fetch failed for ${repoLabel}, proceeding without diffs:`, msg);
        }

        // Build and send prompt to Gemini
        const prompt = buildDigestPrompt(item, repo, diffContent);
        const { text: digestContent, status: geminiStatus } = await callGemini(prompt);

        if (geminiStatus === 429) {
          // Rate limited — put back to pending for next run
          console.warn(`[compose-digest] Gemini rate limited for ${itemLabel}, requeueing`);
          await supabase
            .from('github_ingestion_queue')
            .update({
              status: 'pending',
              retry_count: (item.retry_count ?? 0) + 1,
              error_message: 'Gemini rate limit (429), will retry',
            })
            .eq('id', item.id);
          summary.itemsRetrying++;
          continue;
        }

        if (geminiStatus !== 200 || !digestContent) {
          const newRetryCount = (item.retry_count ?? 0) + 1;
          const maxRetries = item.max_retries ?? 3;
          const nextStatus = newRetryCount >= maxRetries ? 'failed' : 'pending';
          const errMsg = `Gemini returned status ${geminiStatus}`;

          console.error(`[compose-digest] Gemini error for ${itemLabel} (attempt ${newRetryCount}):`, errMsg);
          await supabase
            .from('github_ingestion_queue')
            .update({
              status: nextStatus,
              retry_count: newRetryCount,
              error_message: errMsg,
            })
            .eq('id', item.id);

          if (nextStatus === 'failed') {
            summary.itemsFailed++;
          } else {
            summary.itemsRetrying++;
          }
          summary.errors.push(`${itemLabel}: ${errMsg}`);
          continue;
        }

        // Success — store digest and advance status
        await supabase
          .from('github_ingestion_queue')
          .update({
            status: 'digest_ready',
            digest_content: digestContent,
            error_message: null,
          })
          .eq('id', item.id);

        summary.itemsSucceeded++;
        console.log(`[compose-digest] Digest composed for ${repoLabel} (${item.digest_date})`);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const newRetryCount = (item.retry_count ?? 0) + 1;
        const maxRetries = item.max_retries ?? 3;
        const nextStatus = newRetryCount >= maxRetries ? 'failed' : 'pending';

        console.error(`[compose-digest] Unexpected error for ${itemLabel}:`, err);
        await supabase
          .from('github_ingestion_queue')
          .update({
            status: nextStatus,
            retry_count: newRetryCount,
            error_message: msg,
          })
          .eq('id', item.id);

        if (nextStatus === 'failed') {
          summary.itemsFailed++;
        } else {
          summary.itemsRetrying++;
        }
        summary.errors.push(`${itemLabel}: ${msg}`);
      }
    }

    return res.status(200).json({
      success: true,
      ...summary,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[compose-digest] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
