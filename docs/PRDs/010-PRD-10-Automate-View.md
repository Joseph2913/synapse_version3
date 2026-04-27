# PRD 10 — Automate View: Integration Dashboard & Queue Management

> **Note (2026-04-26):** The Chrome Extension card (Card 5) and all `chrome_extension` metadata queries described in this PRD have been removed from the codebase. Treat any mention of `ChromeExtensionCard`, `extension` summary fields, or `metadata.source = 'chrome_extension'` filters as historical only.

**Phase:** 4 — Automation
**Dependencies:** PRD 2 (Shell + Navigation), PRD 9 (Ingest YouTube/Meetings/Documents — provides playlist and queue data in the database)
**Estimated Complexity:** Low–Medium (1 session)

---

## 1. Objective

Build the Automate view — a centralized operations dashboard where the user monitors all connected integrations, manages the video processing queue, and reviews automation health. This is the "control room" for Synapse's automated ingestion systems. While the Ingest view (PRDs 7 and 9) is where users manually capture and configure content sources, the Automate view is where they observe the system working on their behalf.

The view is primarily read-heavy: it reads real state from YouTube tables, processing queues, and integration configs to present an accurate picture of what's connected, what's running, and what's failed. The key interactive element is the processing queue, which lets users inspect individual queue items, retry failed jobs, cancel pending ones, and clear completed items.

After this PRD, the Automate view transitions from a placeholder to a live operations dashboard. PRD 11 (YouTube Serverless Pipeline) will populate the queue automatically — this PRD provides the interface to observe and manage that automated activity.

---

## 2. What Gets Built

### Views & Components

| File | Type | Description |
|---|---|---|
| `src/views/AutomateView.tsx` | View | Top-level Automate view with integration cards and queue section |
| `src/components/automate/IntegrationDashboard.tsx` | Component | Container for all integration status cards |
| `src/components/automate/IntegrationStatusCard.tsx` | Component | Expandable card showing integration name, status, metric, and config |
| `src/components/automate/YouTubeChannelsCard.tsx` | Component | Specialized card for YouTube channels with channel list |
| `src/components/automate/YouTubePlaylistsCard.tsx` | Component | Specialized card for YouTube playlists with SYN code display |
| `src/components/automate/MeetingIntegrationsCard.tsx` | Component | Card for meeting service connections |
| `src/components/automate/ChromeExtensionCard.tsx` | Component | Card for Chrome Extension status |
| `src/components/automate/ProcessingQueueSection.tsx` | Component | Full queue management section with filters and item list |
| `src/components/automate/QueueFilterBar.tsx` | Component | Filter pills for queue status filtering |
| `src/components/automate/QueueItemCard.tsx` | Component | Individual queue item with status pipeline, metadata, actions |
| `src/components/automate/QueueItemStatusPipeline.tsx` | Component | 5-step visual pipeline indicator for a queue item |
| `src/components/automate/AutomateEmptyState.tsx` | Component | Empty state when no integrations are connected |
| `src/components/automate/ScanHistoryDrawer.tsx` | Component | Slide-over or expandable section showing recent scan history |

### Hooks

| File | Type | Description |
|---|---|---|
| `src/hooks/useAutomationStatus.ts` | Hook | Aggregates all integration statuses and queue data |
| `src/hooks/useProcessingQueue.ts` | Hook | Queue CRUD: fetch, filter, retry, cancel, clear, with polling |

### Service Functions Added to Existing Files

| File | Function | Description |
|---|---|---|
| `src/services/supabase.ts` | `getYouTubeChannels(userId)` | Fetch all `youtube_channels` rows for user |
| `src/services/supabase.ts` | `getQueueItems(userId, filters, pagination)` | Paginated `youtube_ingestion_queue` with status filter |
| `src/services/supabase.ts` | `retryQueueItem(itemId)` | Reset failed item to 'pending', increment retry_count |
| `src/services/supabase.ts` | `cancelQueueItem(itemId)` | Set pending item status to 'skipped' |
| `src/services/supabase.ts` | `clearCompletedItems(userId)` | Delete all 'completed' items from queue |
| `src/services/supabase.ts` | `getScanHistory(userId, limit)` | Fetch recent `youtube_scan_history` rows |
| `src/services/supabase.ts` | `getYouTubeSettings(userId)` | Fetch `youtube_settings` row |
| `src/services/supabase.ts` | `getAutomationSummary(userId)` | Aggregated counts across all automation tables |

### Types

| File | Type | Description |
|---|---|---|
| `src/types/automate.ts` | Types | `IntegrationStatus`, `QueueItem`, `QueueFilter`, `ScanHistoryEntry`, `AutomationSummary` |

---

## 3. Design Requirements

### 3.1 Overall Layout

The Automate view follows the standard center stage layout: `padding: 28px 32px`, `max-width: 840px`, `margin: 0 auto`.

```
┌─────────────────────────────────────────────────┐
│  Automate                                        │
│  Integrations, webhooks, and queues.             │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │ YouTube Channels    active  · 142 videos  │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ YouTube Playlists   active  · 87 videos   │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ Meeting Integrations active · 23 meetings │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ Chrome Extension     active  · 12 captures│    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ─── PROCESSING QUEUE ──────────────────────     │
│  [All] [Pending] [Processing] [Complete] [Failed]│
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │ ▶ Video Title      pending → ... → ...    │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ ▶ Video Title      ● extracting           │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### 3.2 Page Header

- Heading: "Automate" — Cabinet Grotesk, `20px`, weight `700`, `--text-primary`. Margin-bottom: `4px`.
- Subheading: "Integrations, webhooks, and queues." — DM Sans, `13px`, weight `400`, `--text-secondary`. Margin-bottom: `24px`.
- Staggered fade-up on load (heading, then subheading, then cards with `0.05s` incremental delay).

### 3.3 Integration Status Cards

Five integration cards rendered as a vertical list with `6px` gap between cards. Each card uses the `IntegrationStatusCard` component (a generic card that receives its content via props/children) or a specialized variant for complex cards.

#### Generic Card Structure

- Container: `--bg-card`, `1px solid var(--border-subtle)`, `12px` border-radius, `16px 20px` padding. Standard card hover (border darkens, 1px lift, barely-there shadow, `0.18s ease`).
- Layout: horizontal flex, `justify-content: space-between`, `align-items: center`.
- **Left side:**
  - Title: Cabinet Grotesk, `14px`, weight `700`, `--text-primary`. Margin-bottom: `2px`.
  - Description: DM Sans, `12px`, weight `400`, `--text-secondary`.
- **Right side:**
  - Status row: `display: flex`, `align-items: center`, `gap: 5px`, `justify-content: flex-end`. Margin-bottom: `2px`.
    - Status dot: `6px × 6px` circle. Active: `#10b981` (`--semantic-green-500`). Idle: `--text-secondary` (`#808080`). Error: `--semantic-red-500`.
    - Status label: DM Sans, `11px`, weight `600`, same color as dot. Text: "active", "idle", or "error".
  - Metric: DM Sans, `11px`, weight `400`, `--text-secondary`.
- Expand chevron (for expandable cards): Lucide `ChevronDown`, `14px`, `--text-secondary`, at the far right. Rotates `180°` on expand (`0.2s ease`).

#### Card 1: YouTube Channels

| Field | Value Source |
|---|---|
| Title | "YouTube Channels" |
| Description | "{N} channels · RSS every 15min" — N from count of `youtube_channels` where `is_active = true` |
| Status | "active" (green) if any channels exist and `is_active = true`; "idle" (gray) if no channels or all paused |
| Metric | "{total_videos_ingested across all channels} videos" |

**Expanded content:**
- List of connected channels, each showing:
  - Channel name: DM Sans `12px` weight `600` `--text-primary`.
  - Status badge: "Active" green pill or "Paused" gray pill (DM Sans `9px` weight `600`).
  - Last checked: DM Sans `10px` `--text-secondary`, relative time format.
  - Videos ingested count: DM Sans `10px` `--text-secondary`.
- "Manage Channels" tertiary button at the bottom — navigates to Ingest → YouTube tab.
- If no channels: "No channels connected. Add channels to automatically ingest new videos." — DM Sans `12px` `--text-secondary`, centered.

#### Card 2: YouTube Playlists

| Field | Value Source |
|---|---|
| Title | "YouTube Playlists" |
| Description | "{N} playlists · SYN codes assigned" — N from count of `youtube_playlists` where `status = 'active'` |
| Status | "active" (green) if any active playlists; "idle" (gray) if none |
| Metric | "{sum of known_video_count across playlists} videos" |

**Expanded content:**
- List of connected playlists, each showing:
  - Playlist name: DM Sans `12px` weight `600`.
  - SYN code: DM Sans `10px` weight `700`, `--accent-500`, monospace feel. Format: "SYN-4A2F".
  - Video count: DM Sans `10px` `--text-secondary`.
  - Status badge: "Active" green / "Paused" gray / "Error" red.
- "Manage Playlists" tertiary button → navigates to Ingest → YouTube tab.

#### Card 3: Meeting Integrations

| Field | Value Source |
|---|---|
| Title | "Meeting Integrations" |
| Description | Dynamic based on connected services. Circleback detection: check if `knowledge_sources` has rows with `source_type = 'Meeting'` and metadata containing Circleback identifiers. Fallback: "No services connected" |
| Status | "active" (green) if Circleback data exists; "idle" (gray) otherwise |
| Metric | "{N} meetings" — count of `knowledge_sources` where `source_type = 'Meeting'` |

**Expanded content:**
- Integration status list (same integrations from PRD 9's Meetings tab): Circleback, Fireflies, tl;dv, MeetGeek.
- Each shows a status line: connected (green dot) or not connected (gray dot).
- "Configure Integrations" tertiary button → navigates to Ingest → Meetings tab.

#### Card 4: Processing Queue (Summary Card)

| Field | Value Source |
|---|---|
| Title | "Processing Queue" |
| Description | "{pending} pending · {failed} failed" — from `getQueueStats()` (reused from PRD 9) |
| Status | "active" (green) with pulse animation if any items are in `fetching_transcript` or `extracting` status. "idle" (gray) if all items are completed/failed/pending with none actively processing |
| Metric | "Last: {relative_time}" — `completed_at` of the most recently completed queue item |

This card is **not expandable** — it serves as a summary. The full queue section below handles detail. Clicking the card scrolls smoothly to the Processing Queue section.

#### Card 5: Chrome Extension

| Field | Value Source |
|---|---|
| Title | "Chrome Extension" |
| Description | "Connected · One-click capture" if captures exist; "Not installed" if no extension-sourced data |
| Status | "active" (green) if `knowledge_sources` has rows with metadata indicating extension capture; "idle" (gray) otherwise |
| Metric | "{N} captures" — count of extension-sourced entries |

**Expanded content:**
- Connection instructions: "Install the Synapse Chrome Extension to capture content from any web page or YouTube video."
- Link to Chrome Web Store (placeholder URL until PRD 14 is deployed).
- If connected: list of last 5 captures with title, source type, and timestamp.

### 3.4 Processing Queue Section

Separated from the integration cards by `36px` margin-top and a section label.

#### Section Header

- Label: "PROCESSING QUEUE" — Cabinet Grotesk, `10px`, weight `700`, `letter-spacing: 0.08em`, `--text-secondary`, uppercase.
- Right side: "Clear completed" ghost button (DM Sans `11px`, weight `600`, `--text-secondary`). Only appears when completed items exist. On click: calls `clearCompletedItems()`, shows confirmation toast.

#### Queue Filter Bar

Horizontal row of filter pills below the section header, `margin: 12px 0 16px`.

Filter options: All, Pending, Processing, Completed, Failed.

- Pill style (inactive): `--bg-inset` background, `1px solid var(--border-subtle)`, `20px` border-radius, DM Sans `11px` weight `600`, `--text-secondary`, `6px 14px` padding.
- Pill style (active): `--accent-50` background, `1px solid var(--accent-200)`, `--accent-500` text.
- Each pill shows a count badge: DM Sans `9px` weight `700`, inside a `16px` min-width circle. Badge colors:
  - All: `--text-secondary` on `--bg-inset`.
  - Pending: `--semantic-amber-700` on `--semantic-amber-50`.
  - Processing: `--accent-500` on `--accent-50`.
  - Completed: `--semantic-green-700` on `--semantic-green-50`.
  - Failed: `--semantic-red-700` on `--semantic-red-50`.
- Transition between active/inactive: `0.15s ease`.

#### Queue Item Cards

Each queue item renders as a `QueueItemCard`. Vertical list with `6px` gap.

**Card layout:**

- Container: `--bg-card`, `1px solid var(--border-subtle)`, `10px` border-radius, `14px 18px` padding.
- **Top row:** horizontal flex, space-between.
  - Left: source type emoji (`▶` for YouTube) in a tinted container (`22px × 22px`, `--semantic-red-50`, `4px` radius) + video title (DM Sans `13px` weight `600` `--text-primary`, truncated to 1 line) + timestamp (DM Sans `10px` `--text-secondary`, relative format).
  - Right: action buttons (see below per status).
- **Middle row:** Status pipeline visualization (`QueueItemStatusPipeline`).
- **Bottom row** (expandable on click): metadata details.

#### Queue Item Status Pipeline

A horizontal 5-step indicator showing the processing lifecycle. This is the most visually distinctive element on the Automate view.

**Steps:**

| Step | Label | Status Field Match |
|---|---|---|
| 1 | Queued | `'pending'` |
| 2 | Fetching Transcript | `'fetching_transcript'` |
| 3 | Extracting Entities | `'extracting'` |
| 4 | Saving to Graph | *(inferred from extracting → completed transition)* |
| 5 | Complete | `'completed'` |

**Visual design:**

```
  ●────────●────────●────────○────────○
Queued   Fetching  Extracting  Saving  Complete
```

- Each step is a `10px` circle connected by `2px` horizontal lines.
- **Completed steps:** circle filled with `--semantic-green-500`, connector line `--semantic-green-300`.
- **Active step:** circle filled with `--accent-500` with a subtle pulse animation, connector line (from previous) in `--semantic-green-300`.
- **Pending steps:** circle as `--border-default` outline (hollow), connector line `--border-subtle`.
- **Failed state:** the step where failure occurred shows `--semantic-red-500` filled circle with Lucide `X` icon (`8px`, white) inside. All subsequent steps remain hollow. The connector line to the failed step is `--semantic-red-300`.
- Labels below each step: DM Sans `9px` weight `500`, `--text-secondary`. Active step label is `--accent-500`. Failed step label is `--semantic-red-500`.
- Total width: fills the card. Steps are evenly spaced using `justify-content: space-between`.

**Status mapping logic:**

```typescript
function getActiveStep(status: string): number {
  switch (status) {
    case 'pending': return 1;
    case 'fetching_transcript': return 2;
    case 'extracting': return 3;
    case 'completed': return 5;
    case 'failed': return -1; // special handling
    case 'skipped': return 0;
    default: return 0;
  }
}

function getFailedStep(item: QueueItem): number {
  // Infer which step failed based on what data exists
  if (!item.transcript) return 2; // Failed during transcript fetch
  if (item.nodes_created === 0) return 3; // Failed during extraction
  return 4; // Failed during save
}
```

#### Queue Item Actions (Per Status)

| Status | Available Actions |
|---|---|
| `pending` | "Cancel" tertiary button (sets to `skipped`) |
| `fetching_transcript` | *(no actions — in progress)* |
| `extracting` | *(no actions — in progress)* |
| `completed` | "View Source" ghost button → opens SourceDetail in right panel |
| `failed` | "Retry" tertiary accent button + "Dismiss" ghost button |
| `skipped` | "Re-queue" tertiary button (sets back to `pending`) |

- "Retry" button: DM Sans `10px` weight `600`, `--accent-50` background, `1px solid var(--accent-200)`, `--accent-500` text, `6px` radius.
- "Cancel"/"Dismiss" buttons: DM Sans `10px` weight `600`, `--bg-inset`, `--text-secondary`.
- "View Source" button: ghost style, `--accent-500` text.

#### Queue Item Expanded Details

On click, the card expands to show additional metadata:

- **Video URL:** clickable link in `--accent-500`, DM Sans `11px`, opens in new tab.
- **Published date:** DM Sans `11px` `--text-secondary`.
- **Duration:** formatted as "12:34", DM Sans `11px` `--text-secondary`.
- **Transcript status:** "Fetched" (green) / "Not fetched" (gray) / "Failed" (red) with tier info if available.
- **Entities created:** "{nodes_created} entities · {edges_created} relationships" — DM Sans `11px` `--text-secondary`. Only for completed items.
- **Error message** (for failed items): displayed in a subtle red-tinted container (`--semantic-red-50` background, `--semantic-red-500` text at 8px border-radius, `10px` padding, DM Sans `11px`). Full error message from `error_message` column.
- **Retry count:** "Attempt {retry_count + 1} of {max_retries}" — DM Sans `10px` `--text-secondary`.
- **Timing:** "Queued: {created_at} · Started: {started_at} · Completed: {completed_at}" — DM Sans `10px` `--text-secondary`. Only shows fields that have values.

#### Queue Empty State

When no items match the current filter:
- "No {filter} items in queue" — DM Sans `13px` `--text-secondary`, centered.
- For "All" filter with zero items: "Your processing queue is empty. Queue videos from the YouTube tab in Ingest, or connect channels for automatic polling."
- Lucide `Inbox` icon, `40px`, `--text-placeholder`.

### 3.5 Scan History (Optional Section)

Below the queue section, a collapsible "RECENT ACTIVITY" section showing the last 10 entries from `youtube_scan_history`.

- Section label: "RECENT ACTIVITY" — standard section label style.
- Collapsed by default. Toggle with chevron.
- Each entry: single-line row.
  - Scan type icon: 🔄 for `auto_poll`, 🔍 for `manual_scan`, ⚙️ for `process`.
  - Description: "Polled {channel_name}: found {videos_found}, added {videos_added}" — DM Sans `11px` `--text-body`.
  - Timestamp: relative format, DM Sans `10px` `--text-secondary`.
  - Status dot: green (completed), red (failed), amber (partial).
- Row hover: `--bg-hover`, `0.1s ease`.
- "View all" ghost button at bottom if more than 10 entries exist.

### 3.6 Overall Empty State

When no integrations are connected and the queue is empty:
- Full-view centered empty state.
- Icon: Lucide `Zap`, `56px`, `--text-placeholder`.
- Heading: "No automations configured" — Cabinet Grotesk `18px` weight `700` `--text-primary`.
- Subtext: "Connect YouTube channels, playlists, or meeting services to automatically ingest content into your knowledge graph." — DM Sans `13px` `--text-secondary`, `max-width: 420px`, centered.
- Two action buttons below with `12px` gap:
  - "Connect YouTube" secondary button → navigates to Ingest → YouTube tab.
  - "Set up Meetings" tertiary button → navigates to Ingest → Meetings tab.

---

## 4. Data & Service Layer

### 4.1 Automation Summary

```typescript
// services/supabase.ts

export interface AutomationSummary {
  youtube: {
    channelCount: number;
    activeChannelCount: number;
    totalVideosIngested: number;
    playlistCount: number;
    activePlaylistCount: number;
    totalPlaylistVideos: number;
  };
  meetings: {
    totalMeetings: number;
    circlbackConnected: boolean;
  };
  extension: {
    captureCount: number;
    connected: boolean;
  };
  queue: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    lastCompletedAt: string | null;
  };
}

export async function getAutomationSummary(userId: string): Promise<AutomationSummary> {
  const [
    channels,
    playlists,
    meetingSources,
    extensionSources,
    queueStats,
    lastCompleted,
  ] = await Promise.all([
    supabase
      .from('youtube_channels')
      .select('is_active, total_videos_ingested')
      .eq('user_id', userId),
    supabase
      .from('youtube_playlists')
      .select('status, known_video_count')
      .eq('user_id', userId),
    supabase
      .from('knowledge_sources')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('source_type', 'Meeting'),
    supabase
      .from('knowledge_sources')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .contains('metadata', { source: 'chrome_extension' }),
    getQueueStats(userId), // Reuse from PRD 9
    supabase
      .from('youtube_ingestion_queue')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const channelData = channels.data ?? [];
  const playlistData = playlists.data ?? [];

  return {
    youtube: {
      channelCount: channelData.length,
      activeChannelCount: channelData.filter(c => c.is_active).length,
      totalVideosIngested: channelData.reduce((sum, c) => sum + (c.total_videos_ingested ?? 0), 0),
      playlistCount: playlistData.length,
      activePlaylistCount: playlistData.filter(p => p.status === 'active').length,
      totalPlaylistVideos: playlistData.reduce((sum, p) => sum + (p.known_video_count ?? 0), 0),
    },
    meetings: {
      totalMeetings: meetingSources.count ?? 0,
      circlbackConnected: (meetingSources.count ?? 0) > 0, // Heuristic: if meeting sources exist, something is connected
    },
    extension: {
      captureCount: extensionSources.count ?? 0,
      connected: (extensionSources.count ?? 0) > 0,
    },
    queue: {
      ...queueStats,
      lastCompletedAt: lastCompleted.data?.completed_at ?? null,
    },
  };
}
```

### 4.2 Queue Items Fetch

```typescript
// services/supabase.ts

export type QueueStatusFilter = 'all' | 'pending' | 'processing' | 'completed' | 'failed';

export async function getQueueItems(
  userId: string,
  filter: QueueStatusFilter = 'all',
  pagination: { offset: number; limit: number } = { offset: 0, limit: 20 }
): Promise<{ items: QueueItem[]; totalCount: number }> {
  let query = supabase
    .from('youtube_ingestion_queue')
    .select('*', { count: 'exact' })
    .eq('user_id', userId);

  switch (filter) {
    case 'pending':
      query = query.eq('status', 'pending');
      break;
    case 'processing':
      query = query.in('status', ['fetching_transcript', 'extracting']);
      break;
    case 'completed':
      query = query.eq('status', 'completed');
      break;
    case 'failed':
      query = query.eq('status', 'failed');
      break;
    // 'all' — no additional filter
  }

  query = query
    .order('created_at', { ascending: false })
    .range(pagination.offset, pagination.offset + pagination.limit - 1);

  const { data, error, count } = await query;

  if (error) throw new Error(`Failed to fetch queue: ${error.message}`);

  return {
    items: data ?? [],
    totalCount: count ?? 0,
  };
}
```

### 4.3 Queue Item Actions

```typescript
// services/supabase.ts

export async function retryQueueItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: 'pending',
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', itemId)
    .eq('status', 'failed'); // Safety: only retry failed items

  if (error) throw new Error(`Failed to retry item: ${error.message}`);
}

export async function cancelQueueItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({ status: 'skipped' })
    .eq('id', itemId)
    .eq('status', 'pending'); // Safety: only cancel pending items

  if (error) throw new Error(`Failed to cancel item: ${error.message}`);
}

export async function reQueueItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('youtube_ingestion_queue')
    .update({
      status: 'pending',
      error_message: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', itemId)
    .eq('status', 'skipped');

  if (error) throw new Error(`Failed to re-queue item: ${error.message}`);
}

export async function clearCompletedItems(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('youtube_ingestion_queue')
    .delete()
    .eq('user_id', userId)
    .eq('status', 'completed')
    .select('id');

  if (error) throw new Error(`Failed to clear items: ${error.message}`);
  return data?.length ?? 0;
}
```

### 4.4 Scan History

```typescript
// services/supabase.ts

export async function getScanHistory(
  userId: string,
  limit: number = 10
): Promise<ScanHistoryEntry[]> {
  const { data, error } = await supabase
    .from('youtube_scan_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch scan history: ${error.message}`);
  return data ?? [];
}
```

### 4.5 Channel and Playlist Detail Fetches

```typescript
// services/supabase.ts

export async function getYouTubeChannels(userId: string): Promise<YouTubeChannel[]> {
  const { data, error } = await supabase
    .from('youtube_channels')
    .select('*')
    .eq('user_id', userId)
    .order('channel_name', { ascending: true });

  if (error) throw new Error(`Failed to fetch channels: ${error.message}`);
  return data ?? [];
}

export async function getYouTubeSettings(userId: string): Promise<YouTubeSettings | null> {
  const { data, error } = await supabase
    .from('youtube_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch YouTube settings: ${error.message}`);
  return data;
}
```

---

## 5. Interaction & State

### 5.1 `useAutomationStatus` Hook

```typescript
interface UseAutomationStatusReturn {
  summary: AutomationSummary | null;
  channels: YouTubeChannel[];
  playlists: YouTubePlaylist[]; // Reused from PRD 9 types
  scanHistory: ScanHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}
```

- Fetches all summary data on mount via `getAutomationSummary()`.
- Fetches channels and playlists for expanded card content.
- Fetches scan history for the activity section.
- All fetches run in `Promise.all()` for speed.
- `refresh()` re-fetches everything — called after queue actions.

### 5.2 `useProcessingQueue` Hook

```typescript
interface UseProcessingQueueReturn {
  items: QueueItem[];
  totalCount: number;
  filter: QueueStatusFilter;
  isLoading: boolean;
  error: string | null;
  setFilter: (filter: QueueStatusFilter) => void;
  loadMore: () => Promise<void>;
  retryItem: (itemId: string) => Promise<void>;
  cancelItem: (itemId: string) => Promise<void>;
  reQueueItem: (itemId: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  isPolling: boolean;
}
```

- Loads first 20 items on mount with default filter "all".
- `setFilter`: resets pagination and re-fetches.
- `loadMore`: increments offset and appends results.
- Action methods (`retryItem`, `cancelItem`, etc.): call the service function, then optimistically update the local state (change item status in the array without re-fetching), and schedule a background re-fetch after 1 second to sync with the database.
- **Polling:** When any items have `status = 'fetching_transcript'` or `status = 'extracting'`, enable auto-polling every `10 seconds` to update their status. Disable polling when no items are actively processing.

### 5.3 Right Panel Behavior

The Automate view uses the right panel in two scenarios:

1. **Queue item "View Source" click:** Sets right panel to `{ type: 'source', data: source }` using the `source_id` from the completed queue item. Fetches the full `knowledge_sources` row and displays `SourceDetail` (from PRD 6).
2. **Default state:** Right panel shows Quick Access (from PRD 2).

Integration cards do not interact with the right panel — they navigate to the Ingest view instead.

### 5.4 Cross-View Navigation

| Action | Navigation |
|---|---|
| "Manage Channels" button in YouTube Channels card | `/ingest?tab=youtube` |
| "Manage Playlists" button in YouTube Playlists card | `/ingest?tab=youtube` |
| "Configure Integrations" button in Meeting card | `/ingest?tab=meeting` |
| "Connect YouTube" button in empty state | `/ingest?tab=youtube` |
| "Set up Meetings" button in empty state | `/ingest?tab=meeting` |
| "View Source" on completed queue item | Sets right panel to SourceDetail |

---

## 6. Types

```typescript
// types/automate.ts

export interface IntegrationStatus {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'idle' | 'error';
  metric: string;
  metricValue: number;
}

export interface QueueItem {
  id: string;
  user_id: string;
  channel_id: string | null;
  video_id: string;
  video_title: string | null;
  video_url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  status: 'pending' | 'fetching_transcript' | 'extracting' | 'completed' | 'failed' | 'skipped';
  priority: number;
  transcript: string | null;
  transcript_language: string | null;
  transcript_fetched_at: string | null;
  source_id: string | null;
  nodes_created: number;
  edges_created: number;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type QueueStatusFilter = 'all' | 'pending' | 'processing' | 'completed' | 'failed';

export interface ScanHistoryEntry {
  id: string;
  user_id: string;
  channel_id: string | null;
  scan_type: 'manual_scan' | 'auto_poll' | 'process';
  channel_name: string | null;
  videos_found: number;
  videos_added: number;
  videos_skipped: number;
  videos_processed: number;
  videos_failed: number;
  status: 'completed' | 'failed' | 'partial';
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface YouTubeChannel {
  id: string;
  user_id: string;
  channel_id: string;
  channel_name: string;
  channel_url: string;
  thumbnail_url: string | null;
  description: string | null;
  subscriber_count: number | null;
  auto_ingest: boolean;
  extraction_mode: string;
  anchor_emphasis: string;
  linked_anchor_ids: string[];
  custom_instructions: string | null;
  min_video_duration: number;
  max_video_duration: number | null;
  last_checked_at: string | null;
  last_video_published_at: string | null;
  total_videos_ingested: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface YouTubeSettings {
  id: string;
  user_id: string;
  apify_api_key: string | null;
  default_auto_ingest: boolean;
  default_extraction_mode: string;
  default_anchor_emphasis: string;
  max_concurrent_extractions: number;
  max_videos_per_channel: number;
  daily_video_limit: number;
  videos_ingested_today: number;
  daily_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
}
```

---

## 7. Forward-Compatible Decisions

### 7.1 Queue as Shared State (→ PRD 11: YouTube Serverless Pipeline)

The processing queue is the bridge between the UI (this PRD) and the serverless pipeline (PRD 11). PRD 11's cron functions read from `youtube_ingestion_queue` where `status = 'pending'`, process items, and update status. This PRD's polling mechanism detects those status changes and reflects them in the UI. No additional coordination layer is needed — the database is the single source of truth.

### 7.2 Polling Foundation (→ PRD 11, PRD 13)

The `useProcessingQueue` hook's conditional polling pattern (poll when items are actively processing, stop when idle) is reusable. PRD 13's Orientation Engine will need similar polling for digest generation jobs. Extract the polling logic into a generic `usePolling(callback, interval, enabled)` hook if time allows, or at minimum keep the pattern documented for reuse.

### 7.3 Integration Status Pattern (→ Future Integrations)

The `IntegrationStatusCard` component accepts generic props: title, description, status, metric, and optional children for expanded content. Adding a new integration (e.g., Notion import, Slack connector) requires only adding a new card instance with the appropriate data source — no structural changes to the Automate view.

### 7.4 Scan History (→ PRD 11)

The `youtube_scan_history` table will be populated by PRD 11's serverless functions. This PRD's `ScanHistoryDrawer` is ready to display that data. If the table is empty (PRD 11 not yet deployed), the section shows a clean empty state: "No scan activity yet. Activity will appear here once automated polling is configured."

### 7.5 Queue Item → Source Detail Navigation (→ PRD 6)

Completed queue items have a `source_id` linking to `knowledge_sources`. The "View Source" action opens `SourceDetail` in the right panel, which was built in PRD 6. This creates a natural flow: see a completed item in the queue → view its source detail → see the extracted entities → click an entity badge to open NodeDetail. The full chain works across PRDs 4, 6, and 10.

---

## 8. Edge Cases & Error Handling

### 8.1 YouTube Tables Don't Exist

If the YouTube automation tables (`youtube_channels`, `youtube_playlists`, `youtube_ingestion_queue`, `youtube_scan_history`, `youtube_settings`) don't exist yet in the database (they may not have been created in V1), all queries against them will fail. Handle this gracefully:

- Wrap each YouTube-related fetch in try/catch.
- If a table query fails with a "relation does not exist" error, treat it as zero results rather than showing an error.
- The integration cards should show "idle" status with zero metrics.
- The queue section shows the empty state.
- Log the missing table error to console for the developer to address.

### 8.2 Empty State Across All Integrations

When every integration shows zero data:
- Show the full-view empty state (`AutomateEmptyState`) instead of the individual cards.
- This prevents the view from being a wall of "idle" cards with zero metrics, which feels broken.
- The empty state provides clear action paths to the Ingest view.

### 8.3 Queue Item Stuck in Processing

If a queue item has been in `fetching_transcript` or `extracting` status for more than 10 minutes (compare `started_at` to now):
- Display a warning indicator on the item: amber dot instead of the accent-pulsing dot, with text "May be stalled".
- Show a "Force Retry" action button that resets the item to `pending`.

### 8.4 Large Queue (100+ Items)

- Initial load fetches 20 items. "Load more" button appends 20 more.
- Filter counts in the pills use the database count (fast with indexes), not client-side counting.
- "Clear completed" deletes server-side, not just hides client-side.

### 8.5 Concurrent Tab Usage

If the user has both Ingest → YouTube tab and the Automate view open in different tabs:
- Queue actions in one tab won't automatically reflect in the other.
- The Automate view's polling (when active) will eventually catch up.
- No cross-tab communication is needed — the database is the source of truth.

### 8.6 Network Failures

- If the summary fetch fails on mount: show error state "Couldn't load automation status. Check your connection." with a "Retry" button.
- If a queue action fails (retry, cancel, clear): show inline error text below the affected item. Don't remove the item from the list.
- All error messages are dismissed on the next successful action.

### 8.7 Polling Cleanup

The `useProcessingQueue` hook's polling interval must be properly cleaned up on component unmount (clear the `setInterval`). Additionally, if the user navigates away from the Automate view and back, polling should only restart if items are still actively processing. Use `useEffect` cleanup and check `items.some(i => ['fetching_transcript', 'extracting'].includes(i.status))` before enabling the interval.

---

## 9. Acceptance Criteria

After this PRD is complete, a user can:

**Integration Dashboard:**
- [ ] See the Automate view with five integration status cards showing real data from their database
- [ ] See correct active/idle status indicators based on actual integration state
- [ ] See accurate metrics (video counts, meeting counts, capture counts) pulled from live data
- [ ] Expand the YouTube Channels card to see a list of connected channels with their statuses
- [ ] Expand the YouTube Playlists card to see playlists with SYN codes
- [ ] Expand the Meeting Integrations card to see connected/not-connected services
- [ ] Click "Manage" buttons to navigate to the appropriate Ingest tab
- [ ] See the overall empty state with action buttons when no integrations are configured
- [ ] See cards handle missing YouTube tables gracefully (no crashes, shows idle state)

**Processing Queue:**
- [ ] See the processing queue section with accurate filter counts
- [ ] Switch between All/Pending/Processing/Completed/Failed filters
- [ ] See each queue item with the 5-step status pipeline visualization
- [ ] See the correct step highlighted for pending, processing, completed, and failed items
- [ ] See the failed step highlighted in red with an error message for failed items
- [ ] Expand a queue item to see detailed metadata (URL, duration, timestamps, error messages)
- [ ] Click "Retry" on a failed item and see it return to pending status
- [ ] Click "Cancel" on a pending item and see it marked as skipped
- [ ] Click "Re-queue" on a skipped item and see it return to pending
- [ ] Click "View Source" on a completed item and see SourceDetail in the right panel
- [ ] Click "Clear completed" and see all completed items removed
- [ ] See the queue auto-poll every 10 seconds when items are actively processing
- [ ] See the queue empty state with helpful guidance when no items exist
- [ ] Load more items via pagination when the queue has more than 20 items

**Scan History:**
- [ ] See recent scan activity (when `youtube_scan_history` has data)
- [ ] See scan type, channel name, video counts, and timestamps for each entry
- [ ] See a clean empty state when no scan history exists
