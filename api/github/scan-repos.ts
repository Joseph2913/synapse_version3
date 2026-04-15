import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── TYPES ─────────────────────────────────────────────────────────────────────

type ScanInterval = 'hourly' | '6h' | '12h' | 'daily';

interface GitHubTrackedRepo {
  id: string;
  user_id: string;
  owner: string;
  repo: string;
  branch: string;
  scan_interval: ScanInterval;
  status: string;
  last_scanned_at: string | null;
  last_commit_sha: string | null;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
}

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const INTERVAL_MS: Record<ScanInterval, number> = {
  hourly: 3_600_000,
  '6h':   21_600_000,
  '12h':  43_200_000,
  daily:  86_400_000,
};

const SCAN_TOLERANCE_MS = 300_000; // 5-minute window to avoid drift

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

// ─── INTERVAL CHECK ────────────────────────────────────────────────────────────

function shouldScan(repo: GitHubTrackedRepo, now: number): boolean {
  if (!repo.last_scanned_at) return true;
  const lastScanned = new Date(repo.last_scanned_at).getTime();
  const intervalMs = INTERVAL_MS[repo.scan_interval] ?? INTERVAL_MS.daily;
  return (now - lastScanned) >= (intervalMs - SCAN_TOLERANCE_MS);
}

// ─── GITHUB API ────────────────────────────────────────────────────────────────

async function fetchNewCommits(
  owner: string,
  repo: string,
  branch: string,
  since: string | null
): Promise<{ commits: GitHubCommit[]; status: number }> {
  const params = new URLSearchParams({
    sha: branch,
    per_page: '100',
  });
  if (since) params.set('since', since);

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?${params}`,
    {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Synapse-Knowledge-Graph',
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!response.ok) {
    return { commits: [], status: response.status };
  }

  const commits = await response.json() as GitHubCommit[];
  return { commits, status: 200 };
}

// ─── RAW LOG FORMATTER ─────────────────────────────────────────────────────────

function formatCommitLog(commits: GitHubCommit[]): string {
  return commits
    .map(c => {
      const sha = c.sha.slice(0, 7);
      const date = c.commit.author.date.slice(0, 16).replace('T', 'T'); // keep ISO-ish
      const author = c.commit.author.name;
      const message = c.commit.message.split('\n')[0]; // first line only
      return `[${sha}] ${date} (${author})\n${message}`;
    })
    .join('\n\n');
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
  const now = startTime;
  const supabase = getSupabase();
  const digestDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const summary = {
    reposScanned: 0,
    reposQueued: 0,
    reposSkipped: 0,
    errors: [] as string[],
  };

  try {
    // Fetch active repos — scope to requesting user when user-triggered
    let repoQuery = supabase
      .from('github_tracked_repos')
      .select('*')
      .eq('status', 'active');

    if (!isCron && userId) {
      repoQuery = repoQuery.eq('user_id', userId);
    }

    const { data: repos, error: reposError } = await repoQuery;

    if (reposError) {
      return res.status(500).json({ error: reposError.message });
    }

    if (!repos || repos.length === 0) {
      return res.status(200).json({
        success: true,
        ...summary,
        duration_ms: Date.now() - startTime,
      });
    }

    for (const repo of repos as GitHubTrackedRepo[]) {
      const repoLabel = `${repo.owner}/${repo.repo}`;

      // Check if this repo's scan interval has elapsed
      if (!shouldScan(repo, now)) {
        summary.reposSkipped++;
        continue;
      }

      summary.reposScanned++;

      try {
        // Determine `since` — use the date of last scan to bound the query
        const since = repo.last_scanned_at ?? null;

        const { commits, status } = await fetchNewCommits(
          repo.owner,
          repo.repo,
          repo.branch,
          since
        );

        // Handle GitHub errors
        if (status === 404) {
          console.warn(`[scan-repos] Repo not found: ${repoLabel}`);
          await supabase
            .from('github_tracked_repos')
            .update({
              status: 'error',
              error_message: 'Repository not found or not public',
            })
            .eq('id', repo.id);
          summary.errors.push(`${repoLabel}: not found or not public`);
          continue;
        }

        if (status === 403) {
          console.warn(`[scan-repos] Rate limited on ${repoLabel}, skipping`);
          summary.errors.push(`${repoLabel}: GitHub rate limit hit, will retry next hour`);
          continue;
        }

        if (status !== 200) {
          console.error(`[scan-repos] Unexpected status ${status} for ${repoLabel}`);
          summary.errors.push(`${repoLabel}: GitHub API returned ${status}`);
          continue;
        }

        // Filter out the commit we already have (last_commit_sha)
        const newCommits = repo.last_commit_sha
          ? commits.filter(c => c.sha !== repo.last_commit_sha)
          : commits;

        // Update last_scanned_at regardless of new commits
        const latestSha = commits.length > 0 ? commits[0].sha : repo.last_commit_sha;

        await supabase
          .from('github_tracked_repos')
          .update({
            last_scanned_at: new Date(now).toISOString(),
            ...(latestSha ? { last_commit_sha: latestSha } : {}),
          })
          .eq('id', repo.id);

        if (newCommits.length === 0) {
          // No new commits — nothing to queue
          continue;
        }

        // Build queue entry fields
        const oldestSha = newCommits[newCommits.length - 1].sha.slice(0, 7);
        const newestSha = newCommits[0].sha.slice(0, 7);
        const commitRange = `${oldestSha}..${newestSha}`;
        const authors = [...new Set(newCommits.map(c => c.commit.author.name))];
        const rawLog = formatCommitLog(newCommits);

        // Upsert into github_ingestion_queue — update if entry already exists for repo+date
        const { error: upsertError } = await supabase
          .from('github_ingestion_queue')
          .upsert(
            {
              user_id:      repo.user_id,
              repo_id:      repo.id,
              digest_date:  digestDate,
              commit_count: newCommits.length,
              commit_range: commitRange,
              authors,
              raw_log:      rawLog,
              status:       'pending',
            },
            { onConflict: 'repo_id,digest_date' }
          );

        if (upsertError) {
          console.error(`[scan-repos] Queue upsert error for ${repoLabel}:`, upsertError);
          summary.errors.push(`${repoLabel}: ${upsertError.message}`);
        } else {
          summary.reposQueued++;
          console.log(`[scan-repos] Queued ${newCommits.length} commits for ${repoLabel} (${commitRange})`);
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scan-repos] Error processing ${repoLabel}:`, err);
        summary.errors.push(`${repoLabel}: ${msg}`);
      }
    }

    return res.status(200).json({
      success: true,
      ...summary,
      duration_ms: Date.now() - startTime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scan-repos] Fatal error:', err);
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime });
  }
}
