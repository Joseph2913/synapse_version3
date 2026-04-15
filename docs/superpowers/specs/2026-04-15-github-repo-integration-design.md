# GitHub Repository Integration - Design Spec

**Date:** 2026-04-15
**Status:** Draft
**Author:** Joseph Thomas + Claude

---

## Summary

Add a GitHub Repository integration to Synapse that automatically tracks code changes across public repos, generates AI-composed development digests, and ingests them through the existing extraction pipeline. Users add repos through the Synapse UI (Automate view integrations page), configure scan frequency per repo, and the system handles everything else automatically.

---

## Motivation

Synapse captures knowledge from meetings, YouTube videos, and documents. But development work (decisions, debugging breakthroughs, architectural choices, features built) happens in code sessions and currently disappears. Git commit messages capture *what* changed but not *why*. This integration closes that gap by reading git activity, having Gemini interpret it, and feeding the result into the knowledge graph.

---

## How It Works (Plain Language)

1. User goes to Automate view, clicks "GitHub Repository" on the integrations page
2. Enters a public repo URL, gives it a name, picks a scan frequency (hourly/6h/12h/daily)
3. A Vercel cron job runs every hour as a heartbeat
4. For each tracked repo whose interval has elapsed, it checks the GitHub API for new commits
5. If new commits exist, Gemini composes a plain-language development digest from the changes
6. That digest flows through the standard extraction pipeline (entities, relationships, embeddings, chunks, cross-connections)
7. The knowledge appears in the graph like any other source

If nothing changed in a repo since last scan, nothing happens. No cost, no noise.

---

## Architecture

### Pattern

Follows the same three-phase async pipeline as YouTube and Microsoft 365:

| Phase | YouTube | Microsoft 365 | GitHub Repos |
|---|---|---|---|
| 1. Discover | Poll playlist for new videos | Sync calendar/email events | Check GitHub API for new commits |
| 2. Content | Fetch video transcript | Fetch meeting transcript | Compose digest via Gemini |
| 3. Extract | Extract entities via Gemini | Extract entities via Gemini | Extract entities via Gemini |

Key difference: Phase 2 for GitHub *generates* content (Gemini writes a digest) rather than *fetching* existing content (a transcript).

### Data Flow

```
Vercel cron (hourly heartbeat)
  |
  v
/api/github/scan-repos
  - Query github_tracked_repos (is_active=true, interval elapsed)
  - For each: GitHub API -> check for new commits
  - If new commits: create queue entry (status=pending)
  - Update last_scanned_at, last_commit_sha
  |
  v
/api/github/compose-digest
  - Pick up queue items (status=pending)
  - Fetch commit diffs via GitHub API
  - Send to Gemini with digest prompt
  - Store composed markdown (status=digest_ready)
  |
  v
/api/github/extract-knowledge
  - Pick up queue items (status=digest_ready)
  - Call runHeadlessExtraction() with digest as content
  - Standard pipeline: entities, edges, embeddings, chunks, cross-connections
  - Update status=completed, store source_id
```

---

## Database

### Table: `github_tracked_repos`

Parallel to `youtube_playlists`.

| Column | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK (auth.users) | RLS filtered |
| `repo_url` | TEXT NOT NULL | Full GitHub URL |
| `repo_owner` | TEXT NOT NULL | e.g. "Joseph2913" |
| `repo_name` | TEXT NOT NULL | e.g. "synapse_version3" |
| `display_name` | TEXT NOT NULL | User-chosen label e.g. "Synapse V3" |
| `default_branch` | TEXT DEFAULT 'main' | Branch to track |
| `scan_interval` | TEXT DEFAULT 'daily' | 'hourly', '6h', '12h', 'daily' |
| `last_scanned_at` | TIMESTAMPTZ | Last successful scan time |
| `last_commit_sha` | TEXT | Last processed commit hash (delta tracking) |
| `extraction_mode` | TEXT DEFAULT 'comprehensive' | Same as YouTube |
| `anchor_emphasis` | TEXT DEFAULT 'standard' | Same as YouTube |
| `linked_anchor_ids` | UUID[] DEFAULT '{}' | Same as YouTube |
| `custom_instructions` | TEXT | Same as YouTube |
| `is_active` | BOOLEAN DEFAULT true | Enable/disable toggle |
| `status` | TEXT DEFAULT 'active' | 'active', 'paused', 'error' |
| `error_message` | TEXT | Last error if status='error' |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ DEFAULT NOW() | |

RLS: `auth.uid() = user_id` for all operations.

### Table: `github_ingestion_queue`

Parallel to `youtube_ingestion_queue`.

| Column | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | RLS filtered |
| `repo_id` | UUID FK (github_tracked_repos) | Which repo this is for |
| `digest_date` | DATE NOT NULL | The date this digest covers |
| `commit_count` | INT | Number of commits in this digest |
| `commit_range` | TEXT | "abc123..def456" |
| `authors` | TEXT[] | Commit authors in this range |
| `files_changed` | INT | Total files modified |
| `raw_log` | TEXT | Git log output (raw data) |
| `digest_content` | TEXT | Gemini-composed markdown digest |
| `status` | TEXT DEFAULT 'pending' | State machine (see below) |
| `error_message` | TEXT | |
| `retry_count` | INT DEFAULT 0 | |
| `source_id` | UUID FK (knowledge_sources) | After extraction |
| `nodes_created` | INT DEFAULT 0 | |
| `edges_created` | INT DEFAULT 0 | |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Unique constraint:** `UNIQUE(repo_id, digest_date)` - one digest per repo per day.

**Status state machine:**
```
pending -> composing_digest -> digest_ready -> extracting -> completed
    \           \                    \              \
     -> failed   -> failed            -> failed      -> failed
```

Index: `CREATE INDEX idx_gh_queue_status ON github_ingestion_queue(user_id, status)`

---

## Vercel Cron Jobs

Three functions, staggered to allow each phase to complete before the next starts.

Added to `vercel.json`:

```json
{ "path": "/api/github/scan-repos", "schedule": "0 * * * *" },
{ "path": "/api/github/compose-digest", "schedule": "10 * * * *" },
{ "path": "/api/github/extract-knowledge", "schedule": "20 * * * *" }
```

- `scan-repos` runs at the top of every hour (the heartbeat)
- `compose-digest` runs 10 minutes later (gives scan time to finish)
- `extract-knowledge` runs 20 minutes later (gives digest composition time to finish)

Each function is self-contained (no shared local imports), following the Vercel serverless pattern.

### Scan interval logic (in scan-repos)

The cron fires every hour but respects per-repo intervals:

```
for each repo where is_active = true:
  interval_ms = parse(repo.scan_interval)  // 'hourly'=3600000, 'daily'=86400000, etc.
  elapsed = now - repo.last_scanned_at
  if elapsed >= interval_ms:
    scan this repo
  else:
    skip
```

---

## API Functions

### `/api/github/scan-repos.ts`

**Trigger:** Cron (hourly) or manual via auth token

**Flow:**
1. Verify auth (cron secret OR Supabase JWT)
2. Fetch all repos from `github_tracked_repos` where `is_active = true`
3. For each repo, check if scan interval has elapsed since `last_scanned_at`
4. If interval elapsed, call GitHub API:
   - `GET https://api.github.com/repos/{owner}/{repo}/commits?sha={branch}&since={last_scanned_at}`
   - No auth needed for public repos (60 requests/hour limit, sufficient for reasonable repo counts)
5. If new commits found:
   - Create entry in `github_ingestion_queue` with status `pending`
   - Store commit count, commit range (first..last SHA), authors, files changed count
   - Store raw commit log (messages + file lists, not full diffs - those are fetched in Phase 2)
6. Update repo: `last_scanned_at = now()`, `last_commit_sha = latest_commit_sha`
7. If no new commits, do nothing
8. Return summary: `{ reposScanned, reposWithChanges, queueItemsCreated }`

**Error handling:**
- GitHub API 404 -> set repo status='error', error_message='Repository not found or not public'
- GitHub API rate limit (403) -> skip, retry next hour
- Individual repo errors don't block other repos

### `/api/github/compose-digest.ts`

**Trigger:** Cron (hourly, offset +10min) or manual

**Flow:**
1. Fetch up to 3 queue items with status `pending` (ordered by created_at)
2. For each item:
   a. Set status to `composing_digest`
   b. Fetch the repo details from `github_tracked_repos`
   c. Fetch full commit diffs from GitHub API:
      - For each commit in range: `GET /repos/{owner}/{repo}/commits/{sha}`
      - This returns the diff/patch for each commit
      - Limit to first 50 commits and 100KB total diff content (safety cap)
   d. Fetch repo description and README summary for context (one-time, can cache)
   e. Compose Gemini prompt (see Digest Prompt section below)
   f. Call Gemini 2.0 Flash with the prompt
   g. Store response as `digest_content`
   h. Set status to `digest_ready`
3. Return summary: `{ processed, succeeded, failed }`

**Error handling:**
- Gemini timeout/rate limit -> set status back to `pending`, increment `retry_count`
- After 3 retries -> set status to `failed`
- Total function budget: ~50 seconds (Vercel Pro limit is 60s, keep buffer)

### `/api/github/extract-knowledge.ts`

**Trigger:** Cron (hourly, offset +20min) or manual

**Flow:**
1. Fetch up to 2 queue items with status `digest_ready`
2. For each item:
   a. Set status to `extracting`
   b. Fetch extraction settings from the parent `github_tracked_repos` row
   c. Fetch user profile and anchors (same as YouTube pipeline)
   d. Build extraction prompt via `buildExtractionPrompt(config)`
   e. Call Gemini for entity extraction on the digest content
   f. Run the standard pipeline:
      - Save source to `knowledge_sources` (source_type='Document', metadata includes repo info)
      - Save nodes, edges
      - Generate embeddings
      - Chunk digest for RAG
      - Discover cross-connections
   g. Fire-and-forget: trigger `/api/anchors/score-post-extraction`
   h. Update queue item: status='completed', source_id, nodes_created, edges_created
3. Return summary

**Source metadata stored in `knowledge_sources.metadata`:**
```json
{
  "source": "github_integration",
  "repo_url": "https://github.com/Joseph2913/synapse_version3",
  "repo_name": "synapse_version3",
  "digest_date": "2026-04-15",
  "commit_count": 7,
  "commit_range": "abc123..def456",
  "authors": ["Joseph Thomas"],
  "extraction_status": "complete"
}
```

---

## Digest Prompt

The prompt sent to Gemini in Phase 2 to compose the development digest:

```
You are analysing code changes from a GitHub repository for a personal knowledge graph system.

Repository: {repo_name} ({repo_url})
Branch: {default_branch}
Period: {date_from} to {date_to}
Commits: {commit_count}
Authors: {authors}

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

{custom_instructions}

--- COMMITS AND DIFFS ---

{raw_commit_data}
```

---

## UI Components

### Integration card on Automate view

Added to the source type list alongside YouTube Playlist, Microsoft 365, etc:

- **Icon:** GitHub mark (Octocat logo)
- **Label:** "GitHub Repository"
- **Description:** "Track code changes and development activity"
- **Category:** 'github'

### Add repo flow (NewSourcePanel)

When user clicks "GitHub Repository":

1. **Repo URL input** - text field, placeholder "https://github.com/owner/repo"
2. **Display name** - text field, auto-populated from repo name, editable
3. **Branch** - text field, default "main"
4. **Scan frequency** - dropdown: "Every hour", "Every 6 hours", "Every 12 hours", "Daily" (default)
5. **Extraction settings** - same collapsible section as YouTube:
   - Extraction mode (comprehensive/strategic/actionable/relational)
   - Anchor emphasis (passive/standard/aggressive)
   - Linked anchors (multi-select)
   - Custom instructions (textarea)

On submit:
- Validate repo exists and is public via GitHub API (`GET /repos/{owner}/{repo}`)
- Parse owner and repo name from URL
- Insert into `github_tracked_repos`
- Trigger immediate first scan via `/api/github/scan-repos`

### Source card (SourceCard)

Same layout as YouTube playlist cards:
- Repo name (bold)
- GitHub icon + owner/repo handle
- Last scanned: relative time
- Queue badge: pending + processing count
- Status indicator (green dot = active, grey = paused, red = error)

### Source detail panel (SourceDetailPanel)

When a GitHub repo card is selected:

**Settings tab:**
- Display name (editable)
- Repo URL (read-only)
- Branch (editable)
- Scan frequency (dropdown, editable)
- Extraction mode, anchor emphasis, linked anchors, custom instructions (editable)
- Pause / Resume button
- Delete button

**Queue tab:**
- List of digest queue items with status, date, commit count
- Retry failed items button

**History tab:**
- List of completed digests with date, entities extracted, link to source in knowledge graph

---

## Automation Sources Service

### Updates to `src/services/automationSources.ts`

**Add to `AutomationSource` category type:**
```typescript
category: 'youtube-playlist' | 'meeting' | 'microsoft' | 'github'
```

**New functions in a `src/services/githubIntegration.ts` file:**
- `fetchGitHubRepos()` - list all tracked repos for user
- `addGitHubRepo(repoUrl, displayName, branch, scanInterval, settings)` - validate + insert
- `updateGitHubRepo(repoId, updates)` - update settings
- `deleteGitHubRepo(repoId)` - remove repo + queue items
- `pauseGitHubRepo(repoId)` / `resumeGitHubRepo(repoId)`
- `fetchGitHubQueue(repoId)` - queue items for a specific repo
- `triggerGitHubScan(authToken)` - manual scan trigger

**Update `fetchAutomationSources()`** to include GitHub repos in the returned sources array, following the same pattern as YouTube playlists.

---

## Costs

| Component | Per scan (no changes) | Per scan (with changes) |
|---|---|---|
| GitHub API | 1 request (free) | 1 + N commit requests (free) |
| Gemini digest | $0 (skipped) | ~$0.001-0.002 |
| Gemini extraction | $0 (skipped) | ~$0.001-0.002 |
| Gemini embeddings | $0 (skipped) | ~$0.0005 |
| Vercel invocation | ~2 seconds | ~30-60 seconds |
| **Total** | **~$0** | **~$0.003-0.005** |

At daily frequency for 5 repos: roughly $0.01-0.03/day worst case.
At hourly frequency for 5 repos: roughly $0.05-0.15/day worst case (only when there are actual changes).

---

## Scope

### In scope
- Public GitHub repos only
- Track commits on a single branch per repo
- Configurable scan interval per repo (hourly/6h/12h/daily)
- Gemini-composed development digests
- Standard extraction pipeline (entities, relationships, embeddings, chunks, cross-connections)
- UI for add/edit/delete/pause repos on Automate view
- Queue visibility and history

### Out of scope (future)
- Private repos (requires GitHub OAuth or PAT)
- PR/issue/discussion tracking (separate from commit tracking)
- Multi-branch tracking
- Real-time webhook triggers (GitHub push events)
- Ingest API endpoint for external tools (e.g. Claude routines)
- Cross-repo analysis (comparing activity across repos)

---

## Implementation Order

1. Database: Create `github_tracked_repos` and `github_ingestion_queue` tables with RLS
2. API: `/api/github/scan-repos.ts` - the scan function
3. API: `/api/github/compose-digest.ts` - the Gemini digest function
4. API: `/api/github/extract-knowledge.ts` - the extraction function
5. Service: `src/services/githubIntegration.ts` - frontend service layer
6. UI: Add GitHub source type to Automate view (card, add flow, detail panel)
7. Config: Update `vercel.json` with cron schedules
8. Test: End-to-end with synapse_version3 repo
