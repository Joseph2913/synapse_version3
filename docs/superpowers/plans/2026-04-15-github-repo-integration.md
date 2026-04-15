# GitHub Repository Integration - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Repository integration that tracks public repos, generates AI-composed development digests, and ingests them through the existing extraction pipeline.

**Architecture:** Three-phase Vercel cron pipeline (scan-repos -> compose-digest -> extract-knowledge) following the exact pattern of the YouTube integration. A new `github_tracked_repos` table stores repo config, a `github_ingestion_queue` table tracks processing state. The Automate view gets a new "GitHub Repository" source type in the NewSourcePanel with a configure flow matching YouTube playlists.

**Tech Stack:** Supabase (PostgreSQL + RLS), Vercel serverless functions, GitHub REST API (unauthenticated for public repos), Gemini 2.0 Flash (digest composition + entity extraction), React + TypeScript frontend.

**Spec:** `docs/superpowers/specs/2026-04-15-github-repo-integration-design.md`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `api/github/scan-repos.ts` | Cron: check GitHub API for new commits per tracked repo |
| Create | `api/github/compose-digest.ts` | Cron: compose markdown digest via Gemini from raw commit data |
| Create | `api/github/extract-knowledge.ts` | Cron: run extraction pipeline on composed digests |
| Create | `src/services/githubIntegration.ts` | Frontend service: CRUD for tracked repos + queue queries |
| Modify | `src/services/automationSources.ts` | Add 'github' category, include GitHub repos in fetchAutomationSources() |
| Modify | `src/components/automate/NewSourcePanel.tsx` | Add GitHub source type + configure step |
| Modify | `src/components/automate/SourceCard.tsx` | Handle 'github' category rendering |
| Modify | `src/components/automate/SourceDetailPanel.tsx` | Handle 'github' category detail + edit |
| Modify | `src/views/AutomateView.tsx` | Add 'github' to filter tabs |
| Modify | `vercel.json` | Add 3 new cron schedules |

---

## Task 1: Database tables

**Files:**
- Create: SQL migration (run in Supabase SQL editor)

- [ ] **Step 1: Create `github_tracked_repos` table**

Run this SQL in the Supabase SQL editor:

```sql
CREATE TABLE github_tracked_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  repo_url TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  scan_interval TEXT NOT NULL DEFAULT 'daily' CHECK (scan_interval IN ('hourly', '6h', '12h', 'daily')),
  last_scanned_at TIMESTAMPTZ,
  last_commit_sha TEXT,
  extraction_mode TEXT NOT NULL DEFAULT 'comprehensive',
  anchor_emphasis TEXT NOT NULL DEFAULT 'standard',
  linked_anchor_ids UUID[] DEFAULT '{}',
  custom_instructions TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE github_tracked_repos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own GitHub repos"
  ON github_tracked_repos FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_github_repos_user_active
  ON github_tracked_repos(user_id, is_active);
```

- [ ] **Step 2: Create `github_ingestion_queue` table**

```sql
CREATE TABLE github_ingestion_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES github_tracked_repos(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  commit_count INT NOT NULL DEFAULT 0,
  commit_range TEXT,
  authors TEXT[] DEFAULT '{}',
  files_changed INT DEFAULT 0,
  raw_log TEXT,
  digest_content TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'composing_digest', 'digest_ready', 'extracting', 'completed', 'failed')),
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  source_id UUID,
  nodes_created INT DEFAULT 0,
  edges_created INT DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, digest_date)
);

ALTER TABLE github_ingestion_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own GitHub queue"
  ON github_ingestion_queue FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_github_queue_status
  ON github_ingestion_queue(user_id, status);
```

- [ ] **Step 3: Verify tables exist**

Run: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'github%';`

Expected: `github_tracked_repos` and `github_ingestion_queue` both listed.

- [ ] **Step 4: Commit**

No code files to commit for this step (SQL runs in Supabase dashboard).

---

## Task 2: `/api/github/scan-repos.ts` - Scan for new commits

**Files:**
- Create: `api/github/scan-repos.ts`

- [ ] **Step 1: Create the scan-repos serverless function**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// ─── INTERVAL LOGIC ───────────────────────────────────────────────────────────

const INTERVAL_MS: Record<string, number> = {
  hourly: 3_600_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  daily: 86_400_000,
};

function shouldScan(lastScannedAt: string | null, interval: string): boolean {
  if (!lastScannedAt) return true;
  const elapsed = Date.now() - new Date(lastScannedAt).getTime();
  const required = INTERVAL_MS[interval] ?? INTERVAL_MS['daily']!;
  // Allow 5 min tolerance so hourly cron doesn't skip due to slight drift
  return elapsed >= (required - 300_000);
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TrackedRepo {
  id: string;
  user_id: string;
  repo_owner: string;
  repo_name: string;
  display_name: string;
  default_branch: string;
  scan_interval: string;
  last_scanned_at: string | null;
  last_commit_sha: string | null;
  is_active: boolean;
  status: string;
  extraction_mode: string;
  anchor_emphasis: string;
  linked_anchor_ids: string[];
  custom_instructions: string | null;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  stats?: { additions: number; deletions: number; total: number };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const results: Array<{ repo: string; commits: number; error?: string }> = [];

  try {
    // Fetch all active tracked repos (scoped by user if not cron)
    let query = supabase
      .from('github_tracked_repos')
      .select('*')
      .eq('is_active', true)
      .eq('status', 'active');

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: repos, error: reposError } = await query;
    if (reposError) throw new Error(`Failed to fetch repos: ${reposError.message}`);
    if (!repos || repos.length === 0) {
      return res.status(200).json({ message: 'No active repos to scan', results: [] });
    }

    for (const rawRepo of repos) {
      const repo = rawRepo as unknown as TrackedRepo;

      // Check if scan interval has elapsed
      if (!shouldScan(repo.last_scanned_at, repo.scan_interval)) {
        continue;
      }

      try {
        // Fetch commits since last scan from GitHub API
        const since = repo.last_scanned_at
          ? `&since=${repo.last_scanned_at}`
          : `&since=${new Date(Date.now() - 86_400_000).toISOString()}`;

        const ghUrl = `https://api.github.com/repos/${repo.repo_owner}/${repo.repo_name}/commits?sha=${repo.default_branch}&per_page=100${since}`;

        const ghResponse = await fetch(ghUrl, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Synapse-Knowledge-Graph',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!ghResponse.ok) {
          const status = ghResponse.status;
          if (status === 404) {
            await supabase
              .from('github_tracked_repos')
              .update({ status: 'error', error_message: 'Repository not found or not public' })
              .eq('id', repo.id);
            results.push({ repo: repo.display_name, commits: 0, error: 'Repo not found' });
            continue;
          }
          if (status === 403) {
            results.push({ repo: repo.display_name, commits: 0, error: 'GitHub rate limit' });
            continue;
          }
          throw new Error(`GitHub API error: ${status}`);
        }

        const commits = (await ghResponse.json()) as GitHubCommit[];

        if (commits.length === 0) {
          // No new commits - just update last_scanned_at
          await supabase
            .from('github_tracked_repos')
            .update({ last_scanned_at: new Date().toISOString() })
            .eq('id', repo.id);
          results.push({ repo: repo.display_name, commits: 0 });
          continue;
        }

        // Build raw log from commits
        const authors = [...new Set(commits.map(c => c.commit.author.name))];
        const rawLog = commits.map(c => {
          const date = new Date(c.commit.author.date).toISOString().slice(0, 16);
          return `[${c.sha.slice(0, 7)}] ${date} (${c.commit.author.name})\n${c.commit.message}`;
        }).join('\n\n---\n\n');

        const today = new Date().toISOString().slice(0, 10);
        const latestSha = commits[0]!.sha;

        // Check for existing queue entry for this repo+date (upsert)
        const { data: existing } = await supabase
          .from('github_ingestion_queue')
          .select('id')
          .eq('repo_id', repo.id)
          .eq('digest_date', today)
          .maybeSingle();

        if (existing) {
          // Update existing entry with new commits
          await supabase
            .from('github_ingestion_queue')
            .update({
              commit_count: commits.length,
              commit_range: `${commits[commits.length - 1]!.sha.slice(0, 7)}..${latestSha.slice(0, 7)}`,
              authors,
              raw_log: rawLog,
              status: 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', (existing as { id: string }).id);
        } else {
          // Create new queue entry
          await supabase
            .from('github_ingestion_queue')
            .insert({
              user_id: repo.user_id,
              repo_id: repo.id,
              digest_date: today,
              commit_count: commits.length,
              commit_range: `${commits[commits.length - 1]!.sha.slice(0, 7)}..${latestSha.slice(0, 7)}`,
              authors,
              raw_log: rawLog,
              status: 'pending',
            });
        }

        // Update repo tracking state
        await supabase
          .from('github_tracked_repos')
          .update({
            last_scanned_at: new Date().toISOString(),
            last_commit_sha: latestSha,
            updated_at: new Date().toISOString(),
          })
          .eq('id', repo.id);

        results.push({ repo: repo.display_name, commits: commits.length });

      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[scan-repos] Error scanning ${repo.repo_owner}/${repo.repo_name}:`, msg);
        results.push({ repo: repo.display_name, commits: 0, error: msg });
      }
    }

    const totalQueued = results.reduce((sum, r) => sum + r.commits, 0);
    return res.status(200).json({
      reposChecked: results.length,
      reposWithChanges: results.filter(r => r.commits > 0).length,
      totalCommitsQueued: totalQueued,
      results,
    });

  } catch (err) {
    console.error('[scan-repos] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit api/github/scan-repos.ts --esModuleInterop --moduleResolution node --target es2020 --skipLibCheck`

If there are type errors, fix them.

- [ ] **Step 3: Commit**

```bash
git add api/github/scan-repos.ts
git commit -m "feat: add /api/github/scan-repos cron function

Checks GitHub API for new commits on tracked repos, respecting
per-repo scan intervals. Creates queue entries for digest composition."
```

---

## Task 3: `/api/github/compose-digest.ts` - Generate digest via Gemini

**Files:**
- Create: `api/github/compose-digest.ts`

- [ ] **Step 1: Create the compose-digest serverless function**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ITEMS_PER_BATCH = 3;
const MAX_RAW_LOG_CHARS = 80_000;
const MAX_DIFF_CHARS = 50_000;

// ─── AUTH (same pattern as scan-repos) ────────────────────────────────────────

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

interface QueueItem {
  id: string;
  user_id: string;
  repo_id: string;
  digest_date: string;
  commit_count: number;
  commit_range: string | null;
  authors: string[];
  raw_log: string;
  status: string;
  retry_count: number;
}

interface RepoInfo {
  repo_owner: string;
  repo_name: string;
  display_name: string;
  repo_url: string;
  default_branch: string;
  custom_instructions: string | null;
}

// ─── DIGEST PROMPT ────────────────────────────────────────────────────────────

function buildDigestPrompt(
  repo: RepoInfo,
  item: QueueItem,
  diffContent: string
): string {
  return `You are analysing code changes from a GitHub repository for a personal knowledge graph system.

Repository: ${repo.display_name} (${repo.repo_url})
Branch: ${repo.default_branch}
Date: ${item.digest_date}
Commits: ${item.commit_count}
Authors: ${item.authors.join(', ')}

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

${repo.custom_instructions ? `## Additional Instructions:\n${repo.custom_instructions}\n` : ''}
--- COMMIT LOG ---

${item.raw_log?.slice(0, MAX_RAW_LOG_CHARS) ?? 'No commit log available'}

--- CODE DIFFS ---

${diffContent}`;
}

// ─── FETCH DIFFS FROM GITHUB ──────────────────────────────────────────────────

async function fetchDiffs(
  repoOwner: string,
  repoName: string,
  commitRange: string | null,
  rawLog: string
): Promise<string> {
  if (!commitRange) return 'No diff data available.';

  // Extract SHAs from commit log (first 20 commits max for diff fetching)
  const shaPattern = /\[([a-f0-9]{7})\]/g;
  const shas: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = shaPattern.exec(rawLog)) !== null && shas.length < 20) {
    shas.push(match[1]!);
  }

  if (shas.length === 0) return 'No commit SHAs found for diff fetching.';

  let totalDiffContent = '';
  for (const sha of shas) {
    if (totalDiffContent.length >= MAX_DIFF_CHARS) break;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repoName}/commits/${sha}`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Synapse-Knowledge-Graph',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) continue;

      const data = await response.json() as {
        sha: string;
        commit: { message: string };
        files?: Array<{ filename: string; status: string; patch?: string; additions: number; deletions: number }>;
      };

      const files = data.files ?? [];
      const fileSummary = files.map(f => {
        const patch = f.patch ? `\n${f.patch.slice(0, 2000)}` : '';
        return `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})${patch}`;
      }).join('\n');

      totalDiffContent += `\n### ${sha.slice(0, 7)}: ${data.commit.message.split('\n')[0]}\n${fileSummary}\n`;
    } catch {
      continue;
    }
  }

  return totalDiffContent || 'Diff fetch failed for all commits.';
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const results: Array<{ id: string; repo: string; status: string; error?: string }> = [];

  try {
    // Pick up pending queue items
    let query = supabase
      .from('github_ingestion_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: items, error: qError } = await query;
    if (qError) throw new Error(`Failed to fetch queue: ${qError.message}`);
    if (!items || items.length === 0) {
      return res.status(200).json({ message: 'No pending items', results: [] });
    }

    for (const rawItem of items) {
      const item = rawItem as unknown as QueueItem;

      try {
        // Mark as composing
        await supabase
          .from('github_ingestion_queue')
          .update({ status: 'composing_digest', started_at: new Date().toISOString() })
          .eq('id', item.id);

        // Fetch repo info
        const { data: repoData } = await supabase
          .from('github_tracked_repos')
          .select('repo_owner, repo_name, display_name, repo_url, default_branch, custom_instructions')
          .eq('id', item.repo_id)
          .single();

        if (!repoData) throw new Error('Tracked repo not found');
        const repo = repoData as unknown as RepoInfo;

        // Fetch diffs from GitHub
        const diffContent = await fetchDiffs(
          repo.repo_owner,
          repo.repo_name,
          item.commit_range,
          item.raw_log ?? ''
        );

        // Compose digest via Gemini
        const prompt = buildDigestPrompt(repo, item, diffContent);

        const geminiResponse = await fetch(
          `${GEMINI_BASE}/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: prompt }],
              }],
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 4096,
              },
            }),
            signal: AbortSignal.timeout(60000),
          }
        );

        if (!geminiResponse.ok) {
          const errText = await geminiResponse.text();
          if (geminiResponse.status === 429) {
            // Rate limited - put back to pending for retry
            await supabase
              .from('github_ingestion_queue')
              .update({ status: 'pending', retry_count: item.retry_count + 1 })
              .eq('id', item.id);
            results.push({ id: item.id, repo: repo.display_name, status: 'rate_limited' });
            continue;
          }
          throw new Error(`Gemini error: ${geminiResponse.status} ${errText.slice(0, 200)}`);
        }

        const geminiData = await geminiResponse.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        const digestText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!digestText) throw new Error('No digest content from Gemini');

        // Save digest and mark as ready
        await supabase
          .from('github_ingestion_queue')
          .update({
            digest_content: digestText,
            status: 'digest_ready',
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        results.push({ id: item.id, repo: repo.display_name, status: 'digest_ready' });

      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[compose-digest] Error for queue item ${item.id}:`, msg);

        const newRetry = item.retry_count + 1;
        await supabase
          .from('github_ingestion_queue')
          .update({
            status: newRetry >= 3 ? 'failed' : 'pending',
            error_message: msg,
            retry_count: newRetry,
          })
          .eq('id', item.id);

        results.push({ id: item.id, repo: item.repo_id, status: 'failed', error: msg });
      }
    }

    return res.status(200).json({
      processed: results.length,
      succeeded: results.filter(r => r.status === 'digest_ready').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });

  } catch (err) {
    console.error('[compose-digest] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add api/github/compose-digest.ts
git commit -m "feat: add /api/github/compose-digest cron function

Picks up pending queue items, fetches commit diffs from GitHub API,
sends to Gemini to compose a structured development digest."
```

---

## Task 4: `/api/github/extract-knowledge.ts` - Run extraction pipeline

**Files:**
- Create: `api/github/extract-knowledge.ts`

- [ ] **Step 1: Create the extract-knowledge serverless function**

This follows the exact same pattern as `api/youtube/extract-knowledge.ts`. It duplicates the extraction logic inline (no shared imports per Vercel serverless rules).

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

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

interface QueueItem {
  id: string;
  user_id: string;
  repo_id: string;
  digest_date: string;
  commit_count: number;
  commit_range: string | null;
  authors: string[];
  digest_content: string;
  status: string;
  retry_count: number;
}

interface RepoInfo {
  repo_url: string;
  repo_name: string;
  display_name: string;
  extraction_mode: string;
  anchor_emphasis: string;
  linked_anchor_ids: string[];
  custom_instructions: string | null;
}

interface UserProfile {
  professional_context?: { role?: string; current_projects?: string };
  personal_interests?: { topics?: string };
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

// ─── EXTRACTION (inlined, same as youtube/extract-knowledge.ts) ───────────────

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

async function extractEntities(content: string, systemPrompt: string): Promise<ExtractionResult> {
  const response = await fetch(
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
    if (response.status === 429) throw new Error('RATE_LIMITED: Gemini rate limit hit');
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

// ─── MAIN EXTRACTION LOGIC ───────────────────────────────────────────────────

async function extractKnowledgeForItem(
  item: QueueItem,
  repo: RepoInfo,
  supabase: ReturnType<typeof getSupabase>,
  itemStartTime: number
): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
  const content = item.digest_content;

  try {
    await supabase
      .from('github_ingestion_queue')
      .update({ status: 'extracting', started_at: new Date().toISOString() })
      .eq('id', item.id);

    // STEP 1: Save source
    const title = `${repo.display_name} - Dev Digest ${item.digest_date}`;
    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert({
        user_id: item.user_id,
        title,
        source_type: 'Document',
        source_url: repo.repo_url,
        content: content.slice(0, MAX_CONTENT_CHARS),
        metadata: {
          source: 'github_integration',
          repo_url: repo.repo_url,
          repo_name: repo.repo_name,
          digest_date: item.digest_date,
          commit_count: item.commit_count,
          commit_range: item.commit_range,
          authors: item.authors,
          extraction_status: 'processing',
        },
      })
      .select('id')
      .single();

    if (sourceError || !sourceData) {
      throw new Error(`Failed to save source: ${sourceError?.message}`);
    }
    const sourceId = sourceData.id as string;

    await supabase
      .from('github_ingestion_queue')
      .update({ source_id: sourceId })
      .eq('id', item.id);

    // STEP 2: Fetch extraction config
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

    const extractionMode = repo.extraction_mode ?? defaultSettings?.default_mode ?? 'comprehensive';
    const anchorEmphasis = repo.anchor_emphasis ?? defaultSettings?.default_anchor_emphasis ?? 'standard';

    // STEP 3: Gemini extraction
    const systemPrompt = buildExtractionPrompt({
      mode: extractionMode,
      anchorEmphasis,
      anchors,
      userProfile,
      customInstructions: repo.custom_instructions,
    });

    const extraction = await extractEntities(content, systemPrompt);
    const { entities = [], relationships = [] } = extraction;
    console.log(`[github-extract] Extracted ${entities.length} entities, ${relationships.length} relationships for ${repo.display_name} ${item.digest_date}`);

    // STEP 4: Deduplication + save nodes
    const savedNodeMap = new Map<string, string>();
    let nodesCreated = 0;

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

    // Insert new nodes (not exact-matched)
    for (const entity of entities) {
      if (!entity.label || !entity.entity_type) continue;
      if (exactMatchMap.has(entity.label.toLowerCase())) continue;

      const nodePayload: Record<string, unknown> = {
        user_id: item.user_id,
        label: entity.label,
        entity_type: entity.entity_type,
        description: entity.description ?? null,
        confidence: entity.confidence ?? 0.8,
        source: title,
        source_type: 'Document',
        source_url: repo.repo_url,
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

      savedNodeMap.set(entity.label, (nodeData as { id: string }).id);
      nodesCreated++;
    }

    // STEP 5: Save edges
    let edgesCreated = 0;
    for (const rel of relationships) {
      const sourceNodeId = savedNodeMap.get(rel.source);
      const targetNodeId = savedNodeMap.get(rel.target);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;

      const { error: edgeError } = await supabase
        .from('knowledge_edges')
        .insert({
          user_id: item.user_id,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          relation_type: rel.relation_type,
          evidence: rel.evidence ?? null,
          weight: 0.8,
        });

      if (!edgeError) edgesCreated++;
    }

    // STEP 6: Generate embeddings for new nodes
    const newNodeIds = [...savedNodeMap.entries()]
      .filter(([label]) => !exactMatchMap.has(label.toLowerCase()))
      .map(([, id]) => id);

    if (newNodeIds.length > 0) {
      const nodeLabelsForEmbed = entities
        .filter(e => newNodeIds.includes(savedNodeMap.get(e.label) ?? ''))
        .map(e => `${e.entity_type}: ${e.label} - ${e.description ?? ''}`);

      for (let i = 0; i < nodeLabelsForEmbed.length; i += EMBEDDING_CONCURRENCY) {
        const batch = nodeLabelsForEmbed.slice(i, i + EMBEDDING_CONCURRENCY);
        const batchIds = newNodeIds.slice(i, i + EMBEDDING_CONCURRENCY);
        const embeddings = await Promise.all(batch.map(text => generateEmbedding(text)));

        for (let j = 0; j < embeddings.length; j++) {
          const emb = embeddings[j];
          if (emb && emb.length > 0) {
            await supabase
              .from('knowledge_nodes')
              .update({ embedding: emb })
              .eq('id', batchIds[j]);
          }
        }
      }
    }

    // STEP 7: Chunk source for RAG
    const chunks = chunkText(content);
    if (chunks.length > 0) {
      const chunkEmbeddings = await Promise.all(
        chunks.slice(0, 20).map(c => generateEmbedding(c))
      );

      const chunkInserts = chunks.slice(0, 20).map((c, i) => ({
        user_id: item.user_id,
        source_id: sourceId,
        content: c,
        sequence_order: i,
        embedding: chunkEmbeddings[i]?.length ? chunkEmbeddings[i] : null,
      }));

      await supabase.from('source_chunks').insert(chunkInserts);
    }

    // STEP 8: Update source metadata
    await supabase
      .from('knowledge_sources')
      .update({
        metadata: {
          source: 'github_integration',
          repo_url: repo.repo_url,
          repo_name: repo.repo_name,
          digest_date: item.digest_date,
          commit_count: item.commit_count,
          commit_range: item.commit_range,
          authors: item.authors,
          extraction_status: 'complete',
        },
      })
      .eq('id', sourceId);

    // STEP 9: Fire-and-forget anchor scoring
    const elapsed = Date.now() - itemStartTime;
    if (elapsed < TIME_BUDGET_MS) {
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000';
        fetch(`${baseUrl}/api/anchors/score-post-extraction`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CRON_SECRET ?? ''}`,
          },
          body: JSON.stringify({ user_id: item.user_id }),
        }).catch(() => {});
      } catch {}
    }

    return { success: true, nodesCreated, edgesCreated };

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, nodesCreated: 0, edgesCreated: 0, error: msg };
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, isCron } = await verifyUserAuth(req);
  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const results: Array<{ id: string; repo: string; nodes: number; edges: number; error?: string }> = [];

  try {
    let query = supabase
      .from('github_ingestion_queue')
      .select('*')
      .eq('status', 'digest_ready')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: items, error: qError } = await query;
    if (qError) throw new Error(`Failed to fetch queue: ${qError.message}`);
    if (!items || items.length === 0) {
      return res.status(200).json({ message: 'No items ready for extraction', results: [] });
    }

    for (const rawItem of items) {
      const item = rawItem as unknown as QueueItem;
      const itemStart = Date.now();

      // Fetch repo info
      const { data: repoData } = await supabase
        .from('github_tracked_repos')
        .select('repo_url, repo_name, display_name, extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions')
        .eq('id', item.repo_id)
        .single();

      if (!repoData) {
        await supabase
          .from('github_ingestion_queue')
          .update({ status: 'failed', error_message: 'Tracked repo not found' })
          .eq('id', item.id);
        continue;
      }
      const repo = repoData as unknown as RepoInfo;

      const result = await extractKnowledgeForItem(item, repo, supabase, itemStart);

      if (result.success) {
        await supabase
          .from('github_ingestion_queue')
          .update({
            status: 'completed',
            nodes_created: result.nodesCreated,
            edges_created: result.edgesCreated,
            completed_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        results.push({ id: item.id, repo: repo.display_name, nodes: result.nodesCreated, edges: result.edgesCreated });
      } else {
        const newRetry = item.retry_count + 1;
        await supabase
          .from('github_ingestion_queue')
          .update({
            status: newRetry >= 3 ? 'failed' : 'digest_ready',
            error_message: result.error,
            retry_count: newRetry,
          })
          .eq('id', item.id);
        results.push({ id: item.id, repo: repo.display_name, nodes: 0, edges: 0, error: result.error });
      }
    }

    return res.status(200).json({
      processed: results.length,
      succeeded: results.filter(r => !r.error).length,
      results,
    });

  } catch (err) {
    console.error('[github-extract] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add api/github/extract-knowledge.ts
git commit -m "feat: add /api/github/extract-knowledge cron function

Runs Gemini entity extraction on composed digests, saves nodes,
edges, embeddings, and chunks to the knowledge graph."
```

---

## Task 5: Update `vercel.json` with cron schedules

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add three GitHub cron entries**

Add these three entries to the `crons` array in `vercel.json`:

```json
{
  "path": "/api/github/scan-repos",
  "schedule": "0 * * * *"
},
{
  "path": "/api/github/compose-digest",
  "schedule": "10 * * * *"
},
{
  "path": "/api/github/extract-knowledge",
  "schedule": "20 * * * *"
}
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: add GitHub integration cron schedules

Hourly heartbeat: scan at :00, compose digest at :10, extract at :20.
Per-repo frequency controlled by scan_interval in database."
```

---

## Task 6: Frontend service - `src/services/githubIntegration.ts`

**Files:**
- Create: `src/services/githubIntegration.ts`

- [ ] **Step 1: Create the GitHub integration service**

```typescript
import { supabase } from './supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitHubTrackedRepo {
  id: string
  user_id: string
  repo_url: string
  repo_owner: string
  repo_name: string
  display_name: string
  default_branch: string
  scan_interval: string
  last_scanned_at: string | null
  last_commit_sha: string | null
  extraction_mode: string
  anchor_emphasis: string
  linked_anchor_ids: string[]
  custom_instructions: string | null
  is_active: boolean
  status: string
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface GitHubQueueItem {
  id: string
  repo_id: string
  digest_date: string
  commit_count: number
  commit_range: string | null
  authors: string[]
  status: string
  error_message: string | null
  source_id: string | null
  nodes_created: number
  edges_created: number
  created_at: string
  completed_at: string | null
}

// ─── Fetch repos ─────────────────────────────────────────────────────────────

export async function fetchGitHubRepos(): Promise<GitHubTrackedRepo[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('github_tracked_repos')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Failed to fetch GitHub repos:', error)
    return []
  }

  return (data ?? []) as unknown as GitHubTrackedRepo[]
}

// ─── Add repo ────────────────────────────────────────────────────────────────

function parseGitHubUrl(url: string): { owner: string; name: string } | null {
  // Handle: https://github.com/owner/repo, github.com/owner/repo, owner/repo
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '')
  const match = cleaned.match(/(?:github\.com\/)?([^/]+)\/([^/]+)$/)
  if (!match) return null
  return { owner: match[1]!, name: match[2]! }
}

export async function addGitHubRepo(
  repoUrl: string,
  displayName: string,
  branch: string,
  scanInterval: string,
  settings: {
    mode: string
    emphasis: string
    linkedAnchorIds: string[]
    customInstructions?: string
  }
): Promise<GitHubTrackedRepo> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed) throw new Error('Invalid GitHub URL. Use format: https://github.com/owner/repo')

  // Verify repo exists and is public
  const ghResponse = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.name}`,
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Synapse-Knowledge-Graph',
      },
    }
  )

  if (!ghResponse.ok) {
    if (ghResponse.status === 404) {
      throw new Error('Repository not found. Make sure it exists and is public.')
    }
    throw new Error(`GitHub API error: ${ghResponse.status}`)
  }

  const normalizedUrl = `https://github.com/${parsed.owner}/${parsed.name}`

  const { data, error } = await supabase
    .from('github_tracked_repos')
    .insert({
      user_id: user.id,
      repo_url: normalizedUrl,
      repo_owner: parsed.owner,
      repo_name: parsed.name,
      display_name: displayName || parsed.name,
      default_branch: branch || 'main',
      scan_interval: scanInterval || 'daily',
      extraction_mode: settings.mode,
      anchor_emphasis: settings.emphasis,
      linked_anchor_ids: settings.linkedAnchorIds.length > 0 ? settings.linkedAnchorIds : undefined,
      custom_instructions: settings.customInstructions || undefined,
    })
    .select('*')
    .single()

  if (error) throw new Error(`Failed to add repo: ${error.message}`)
  return data as unknown as GitHubTrackedRepo
}

// ─── Update repo ─────────────────────────────────────────────────────────────

export async function updateGitHubRepo(
  repoId: string,
  updates: Partial<{
    display_name: string
    default_branch: string
    scan_interval: string
    extraction_mode: string
    anchor_emphasis: string
    linked_anchor_ids: string[]
    custom_instructions: string | null
  }>
): Promise<void> {
  const { error } = await supabase
    .from('github_tracked_repos')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', repoId)

  if (error) throw new Error(`Failed to update repo: ${error.message}`)
}

// ─── Pause / Resume ──────────────────────────────────────────────────────────

export async function setGitHubRepoActive(repoId: string, active: boolean): Promise<void> {
  const { error } = await supabase
    .from('github_tracked_repos')
    .update({
      is_active: active,
      status: active ? 'active' : 'paused',
      updated_at: new Date().toISOString(),
    })
    .eq('id', repoId)

  if (error) throw new Error(`Failed to update repo status: ${error.message}`)
}

// ─── Delete repo ─────────────────────────────────────────────────────────────

export async function deleteGitHubRepo(repoId: string): Promise<void> {
  // Queue items cascade on delete via FK
  const { error } = await supabase
    .from('github_tracked_repos')
    .delete()
    .eq('id', repoId)

  if (error) throw new Error(`Failed to delete repo: ${error.message}`)
}

// ─── Queue queries ───────────────────────────────────────────────────────────

export async function fetchGitHubQueue(repoId: string): Promise<GitHubQueueItem[]> {
  const { data, error } = await supabase
    .from('github_ingestion_queue')
    .select('id, repo_id, digest_date, commit_count, commit_range, authors, status, error_message, source_id, nodes_created, edges_created, created_at, completed_at')
    .eq('repo_id', repoId)
    .order('digest_date', { ascending: false })
    .limit(30)

  if (error) return []
  return (data ?? []) as unknown as GitHubQueueItem[]
}

export async function fetchGitHubQueueStats(): Promise<{
  pending: number
  processing: number
  completed: number
  failed: number
}> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  const { data, error } = await supabase
    .from('github_ingestion_queue')
    .select('status')
    .eq('user_id', user.id)

  if (error || !data) return { pending: 0, processing: 0, completed: 0, failed: 0 }

  const rows = data as Array<{ status: string }>
  return {
    pending: rows.filter(r => r.status === 'pending').length,
    processing: rows.filter(r => r.status === 'composing_digest' || r.status === 'extracting').length,
    completed: rows.filter(r => r.status === 'completed').length,
    failed: rows.filter(r => r.status === 'failed').length,
  }
}

// ─── Trigger manual scan ─────────────────────────────────────────────────────

export async function triggerGitHubScan(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  await fetch('/api/github/scan-repos', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/githubIntegration.ts
git commit -m "feat: add GitHub integration frontend service

CRUD operations for tracked repos, queue queries, and manual scan trigger."
```

---

## Task 7: Update `automationSources.ts` to include GitHub repos

**Files:**
- Modify: `src/services/automationSources.ts`

- [ ] **Step 1: Add 'github' to the AutomationSource category type**

In `src/services/automationSources.ts`, update the `category` field in the `AutomationSource` interface:

```typescript
// Change this line:
category: 'youtube-playlist' | 'meeting' | 'microsoft'
// To:
category: 'youtube-playlist' | 'meeting' | 'microsoft' | 'github'
```

- [ ] **Step 2: Add import for GitHub service**

At the top of the file, add:

```typescript
import { fetchGitHubRepos, fetchGitHubQueueStats } from './githubIntegration'
```

- [ ] **Step 3: Add GitHub repos to fetchAutomationSources()**

After the Microsoft 365 section (after the `try/catch` block that pushes the microsoft source), add:

```typescript
  // GitHub tracked repos
  try {
    const ghRepos = await fetchGitHubRepos()
    const ghQueueStats = await fetchGitHubQueueStats()

    for (const repo of ghRepos) {
      sources.push({
        id: repo.id,
        category: 'github',
        name: repo.display_name,
        handle: `${repo.repo_owner}/${repo.repo_name}`,
        description: `Tracking ${repo.default_branch} branch`,
        status: repo.is_active
          ? (repo.status === 'active' ? 'active' : repo.status === 'error' ? 'error' : 'paused')
          : 'paused',
        videosIngested: ghQueueStats.completed,
        lastScan: toRelativeTime(repo.last_scanned_at),
        mode: repo.extraction_mode,
        emphasis: repo.anchor_emphasis,
        linkedAnchors: repo.linked_anchor_ids ?? [],
        customInstructions: repo.custom_instructions ?? undefined,
        provider: 'github',
        queue: {
          pending: ghQueueStats.pending,
          processing: ghQueueStats.processing,
          complete: ghQueueStats.completed,
          failed: ghQueueStats.failed,
        },
      })
    }
  } catch {}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/automationSources.ts
git commit -m "feat: include GitHub repos in automation sources list

Adds 'github' category and fetches tracked repos alongside
YouTube playlists and Microsoft 365 in fetchAutomationSources()."
```

---

## Task 8: Update NewSourcePanel to add GitHub source type

**Files:**
- Modify: `src/components/automate/NewSourcePanel.tsx`

- [ ] **Step 1: Add 'github' to SourceTypeId and SOURCE_TYPES**

Update the type and array near the top of the file:

```typescript
// Change:
type SourceTypeId = 'youtube-playlist' | 'circleback' | 'firefly' | 'microsoft'
// To:
type SourceTypeId = 'youtube-playlist' | 'circleback' | 'firefly' | 'microsoft' | 'github'
```

Add to the SOURCE_TYPES array (after the Microsoft 365 entry):

```typescript
{ id: 'github' as SourceTypeId, logo: '/logos/github.svg', label: 'GitHub Repository', description: 'Track code changes and development activity' },
```

- [ ] **Step 2: Add GitHub logo**

Download or create a GitHub mark SVG and save it to `public/logos/github.svg`. A simple GitHub Octocat mark works. If you don't have one, use this inline SVG saved as the file:

```svg
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" fill="#24292f"/></svg>
```

- [ ] **Step 3: Add GitHub configure step in the NewSourcePanel component**

Inside the `NewSourcePanel` component, find the section that handles `step === 'configure'` rendering. Add a case for `selectedType === 'github'`. This needs to be added alongside the existing YouTube and Microsoft configure blocks.

Add these imports at the top:

```typescript
import { addGitHubRepo } from '../../services/githubIntegration'
import { GitBranch } from 'lucide-react'
```

Add state for the GitHub form fields (inside the component, alongside existing state):

```typescript
const [ghRepoUrl, setGhRepoUrl] = useState('')
const [ghDisplayName, setGhDisplayName] = useState('')
const [ghBranch, setGhBranch] = useState('main')
const [ghScanInterval, setGhScanInterval] = useState('daily')
```

Add the GitHub configure UI block. This should be rendered when `selectedType === 'github'` in the step === 'configure' section, following the same pattern as the YouTube configuration. The key fields are:

1. Repository URL input (text, validates GitHub URL format)
2. Display name input (text, auto-populated from repo name)
3. Branch input (text, default "main")
4. Scan frequency selector (4 pill buttons: Hourly, Every 6h, Every 12h, Daily)
5. ExtractionSettingsForm (the shared component already used by YouTube)
6. Connect button that calls `addGitHubRepo()`

The scan frequency selector uses the same pill button styling as the Anchor Emphasis buttons:

```typescript
const SCAN_INTERVALS = [
  { id: 'hourly', label: 'Hourly' },
  { id: '6h', label: 'Every 6h' },
  { id: '12h', label: 'Every 12h' },
  { id: 'daily', label: 'Daily' },
]
```

The connect handler:

```typescript
const handleConnectGitHub = async () => {
  setLoading(true)
  setError(null)
  try {
    const repo = await addGitHubRepo(
      ghRepoUrl,
      ghDisplayName,
      ghBranch,
      ghScanInterval,
      {
        mode: settings.mode,
        emphasis: settings.emphasis,
        linkedAnchorIds: settings.linkedAnchorIds,
        customInstructions: settings.customInstructions,
      }
    )
    onSourceAdded({
      id: repo.id,
      category: 'github',
      name: repo.display_name,
      handle: `${repo.repo_owner}/${repo.repo_name}`,
      description: `Tracking ${repo.default_branch} branch`,
      status: 'active',
      lastScan: 'Never',
      mode: repo.extraction_mode,
      emphasis: repo.anchor_emphasis,
      linkedAnchors: repo.linked_anchor_ids ?? [],
      customInstructions: repo.custom_instructions ?? undefined,
      provider: 'github',
      queue: { pending: 0, processing: 0, complete: 0, failed: 0 },
    })
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to add repository')
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/automate/NewSourcePanel.tsx public/logos/github.svg
git commit -m "feat: add GitHub Repository source type to NewSourcePanel

Users can add a public GitHub repo with URL, branch, scan frequency,
and extraction settings."
```

---

## Task 9: Update SourceCard for GitHub category

**Files:**
- Modify: `src/components/automate/SourceCard.tsx`

- [ ] **Step 1: Add GitHub rendering in SourceCard**

The SourceCard already handles multiple categories. Find where it conditionally renders based on `source.category` and add handling for `'github'`:

- Icon: Use the GitHub logo from `/logos/github.svg` (same pattern as YouTube playlist icons)
- Stats row: Show "Digests ingested" count (using `source.videosIngested` which we mapped to `ghQueueStats.completed`), last scan time, mode badge
- Handle text: Show `source.handle` which contains `owner/repo`

The changes should be minimal since SourceCard already has a generic rendering path. Just ensure the GitHub icon renders correctly and the stats labels make sense ("Digests" instead of "Videos").

- [ ] **Step 2: Commit**

```bash
git add src/components/automate/SourceCard.tsx
git commit -m "feat: handle GitHub category in SourceCard rendering"
```

---

## Task 10: Update SourceDetailPanel for GitHub category

**Files:**
- Modify: `src/components/automate/SourceDetailPanel.tsx`

- [ ] **Step 1: Add GitHub handling in SourceDetailPanel**

The detail panel needs to:
- Show GitHub-specific fields in edit mode: display name, branch, scan frequency
- Show queue items with the correct status steps (pending -> composing -> extracting -> complete)
- Show "Scan Now" button that calls `triggerGitHubScan()`
- Handle pause/resume via `setGitHubRepoActive()`
- Handle delete via `deleteGitHubRepo()`
- Handle settings update via `updateGitHubRepo()`

Add imports:

```typescript
import {
  updateGitHubRepo,
  setGitHubRepoActive,
  deleteGitHubRepo,
  fetchGitHubQueue,
  triggerGitHubScan,
} from '../../services/githubIntegration'
```

The key changes:
- In the edit panel, add scan interval selector (same pill buttons as NewSourcePanel)
- In the action buttons, wire up pause/resume/delete to the GitHub service functions
- In the queue display, map GitHub statuses to steps: `pending` -> 'queued', `composing_digest` -> 'fetching', `extracting` -> 'extracting', `completed` -> 'complete'
- Add a "Scan Now" button alongside the existing refresh button

- [ ] **Step 2: Commit**

```bash
git add src/components/automate/SourceDetailPanel.tsx
git commit -m "feat: handle GitHub category in SourceDetailPanel

Edit scan frequency, pause/resume, delete, scan now, and queue display
for tracked GitHub repositories."
```

---

## Task 11: Update AutomateView filter tabs

**Files:**
- Modify: `src/views/AutomateView.tsx`

- [ ] **Step 1: Add 'github' to filter type and tabs**

Find the `FilterType` type definition and add `'github'`:

```typescript
// Change:
type FilterType = 'all' | 'youtube-playlist' | 'meeting' | 'microsoft' | 'api'
// To:
type FilterType = 'all' | 'youtube-playlist' | 'meeting' | 'microsoft' | 'github' | 'api'
```

Add a "GitHub" tab in the filter tabs array, with a count of GitHub sources.

In the category grouping logic (where sources are grouped by category when filter === 'all'), add 'github' to the category order array.

- [ ] **Step 2: Commit**

```bash
git add src/views/AutomateView.tsx
git commit -m "feat: add GitHub filter tab to AutomateView"
```

---

## Task 12: End-to-end test

- [ ] **Step 1: Verify database tables exist in Supabase**

Check that both `github_tracked_repos` and `github_ingestion_queue` tables exist and have the correct columns.

- [ ] **Step 2: Start dev server and add a repo through the UI**

Run: `npm run dev`

Navigate to the Automate view. Click "Connect Source". Verify "GitHub Repository" appears in the available sources list. Click it. Enter `https://github.com/Joseph2913/synapse_version3`, give it a name, set to "Daily", and click Connect.

Verify the repo appears as a source card in the Automate view.

- [ ] **Step 3: Test the scan function manually**

Run in browser console or via curl:
```bash
curl -X POST http://localhost:3000/api/github/scan-repos \
  -H "Authorization: Bearer <your-supabase-jwt>"
```

Verify it returns commits found and a queue entry was created.

- [ ] **Step 4: Test the compose-digest function**

```bash
curl -X POST http://localhost:3000/api/github/compose-digest \
  -H "Authorization: Bearer <your-supabase-jwt>"
```

Verify the queue item now has `digest_content` populated and status is `digest_ready`.

- [ ] **Step 5: Test the extract-knowledge function**

```bash
curl -X POST http://localhost:3000/api/github/extract-knowledge \
  -H "Authorization: Bearer <your-supabase-jwt>"
```

Verify the queue item is now `completed` with `nodes_created > 0`. Check that a new source appears in `knowledge_sources` with metadata containing `source: 'github_integration'`.

- [ ] **Step 6: Verify in the Explore view**

Navigate to Explore and search for entities from the digest. Verify they appear in the graph.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete GitHub Repository integration

Adds tracked repo management UI, three-phase cron pipeline
(scan -> compose digest -> extract), and full extraction
pipeline integration for automated code change tracking."
```
