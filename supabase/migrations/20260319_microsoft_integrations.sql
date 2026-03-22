-- Microsoft 365 integration: stores OAuth tokens and sync state
-- Supports Outlook calendar, email, and Teams meeting transcript ingestion

create table if not exists microsoft_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- OAuth tokens (encrypted at rest via Supabase)
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scopes text[] not null default '{}',

  -- Microsoft account info
  microsoft_user_id text,
  microsoft_email text,
  display_name text,

  -- Sync state
  calendar_delta_link text,          -- delta link for incremental calendar sync
  mail_delta_link text,              -- delta link for incremental mail sync
  last_calendar_sync timestamptz,
  last_mail_sync timestamptz,

  -- Webhook subscriptions
  calendar_subscription_id text,
  mail_subscription_id text,
  calendar_subscription_expires timestamptz,
  mail_subscription_expires timestamptz,

  -- Settings
  sync_calendar boolean not null default true,
  sync_mail boolean not null default false,
  sync_transcripts boolean not null default true,
  mail_folders text[] default '{}',   -- specific folder IDs to sync; empty = inbox only

  -- Extraction settings (same pattern as youtube_playlists)
  extraction_mode text not null default 'comprehensive',
  anchor_emphasis text not null default 'standard',
  linked_anchor_ids uuid[] default '{}',
  custom_instructions text,

  -- Status
  status text not null default 'connected' check (status in ('connected', 'paused', 'error', 'expired')),
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One Microsoft integration per user
  unique(user_id)
);

-- RLS
alter table microsoft_integrations enable row level security;

create policy "Users can manage their own Microsoft integration"
  on microsoft_integrations
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Microsoft ingestion queue (parallels youtube_ingestion_queue)
create table if not exists microsoft_ingestion_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Source identification
  microsoft_resource_id text not null,   -- Graph API resource ID (event ID, message ID)
  resource_type text not null check (resource_type in ('calendar_event', 'email', 'meeting_transcript')),

  -- Content
  title text,
  content text,                          -- extracted text content
  event_start timestamptz,               -- for calendar events
  event_end timestamptz,
  attendees jsonb,                       -- [{name, email}]
  online_meeting_id text,                -- Teams meeting ID for transcript lookup

  -- Processing state
  status text not null default 'pending' check (status in ('pending', 'fetching_content', 'content_ready', 'extracting', 'completed', 'failed', 'skipped')),
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,

  -- Extraction results
  source_id uuid references knowledge_sources(id),
  nodes_created int default 0,
  edges_created int default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Prevent duplicate processing
  unique(user_id, microsoft_resource_id)
);

-- RLS
alter table microsoft_ingestion_queue enable row level security;

create policy "Users can manage their own Microsoft queue"
  on microsoft_ingestion_queue
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for efficient queue polling
create index if not exists idx_ms_queue_user_status
  on microsoft_ingestion_queue(user_id, status);

create index if not exists idx_ms_integration_user
  on microsoft_integrations(user_id);
