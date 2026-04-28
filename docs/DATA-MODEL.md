# DATA-MODEL.md — Synapse V2 Supabase Schema

## Overview

Synapse V2 connects to an **existing** Supabase project. The database already contains user data from v1. This document defines every table, column, and policy. **Do not create new tables or modify existing schema without explicit instruction in a PRD.**

Supabase Project URL: Uses the `VITE_SUPABASE_URL` environment variable.

All tables use Row Level Security (RLS). Every table has a `user_id` column referencing `auth.users(id)`, and RLS policies ensure `auth.uid() = user_id` for all operations (SELECT, INSERT, UPDATE, DELETE).

---

## Core Knowledge Tables

### `knowledge_nodes`

The primary entity table. Each row is a single extracted entity (person, concept, project, etc.).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `label` | TEXT | NO | — | Entity name (e.g., "Graph RAG Pipeline") |
| `entity_type` | TEXT | NO | — | One of the ontology types (Person, Topic, Project, etc.) |
| `description` | TEXT | YES | — | AI-generated description of the entity |
| `confidence` | FLOAT | YES | — | Extraction confidence score (0.0–1.0) |
| `is_anchor` | BOOLEAN | YES | `false` | Whether this node is a user-designated anchor |
| `source` | TEXT | YES | — | Human-readable source name |
| `source_type` | TEXT | YES | — | Source category (Meeting, YouTube, Research, Note, Document) |
| `source_url` | TEXT | YES | — | URL of the original source |
| `source_id` | UUID | YES | — | FK to `knowledge_sources(id)`, ON DELETE SET NULL |
| `tags` | TEXT[] | YES | — | AI-generated tags |
| `user_tags` | TEXT[] | YES | — | User-defined project tags |
| `quote` | TEXT | YES | — | Direct quote from source supporting this entity |
| `embedding` | VECTOR(3072) | YES | — | Gemini text-embedding-004 vector for semantic search |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | Creation timestamp |

**Key indexes:**
- `idx_knowledge_nodes_user_id` on `(user_id)`
- `idx_knowledge_nodes_entity_type` on `(user_id, entity_type)`
- `idx_knowledge_nodes_is_anchor` on `(user_id, is_anchor)` WHERE `is_anchor = true`
- Vector index on `embedding` for cosine similarity search

### `knowledge_edges`

Relationships between entities.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `source_node_id` | UUID | NO | — | FK to `knowledge_nodes(id)`, ON DELETE CASCADE |
| `target_node_id` | UUID | NO | — | FK to `knowledge_nodes(id)`, ON DELETE CASCADE |
| `relation_type` | TEXT | YES | — | Relationship label (supports, blocks, part_of, etc.) |
| `evidence` | TEXT | YES | — | AI-generated justification for this relationship |
| `weight` | FLOAT | YES | `1.0` | Relationship strength/confidence |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | Creation timestamp |

**Key indexes:**
- `idx_knowledge_edges_user_id` on `(user_id)`
- `idx_knowledge_edges_source_node` on `(source_node_id)`
- `idx_knowledge_edges_target_node` on `(target_node_id)`

### `knowledge_sources`

Raw ingested content before extraction.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `title` | TEXT | YES | — | Source title |
| `content` | TEXT | YES | — | Full raw content (transcript, article text, notes) |
| `source_type` | TEXT | YES | — | Category (Meeting, YouTube, Research, Note, Document) |
| `source_url` | TEXT | YES | — | Original URL |
| `metadata` | JSONB | YES | `'{}'` | Flexible metadata (duration, channel, author, etc.) |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | Creation timestamp |

### `source_chunks`

Content chunked for RAG retrieval. Each source is split into ~500-token passages with embeddings.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `source_id` | UUID | NO | — | FK to `knowledge_sources(id)`, ON DELETE CASCADE |
| `chunk_index` | INTEGER | NO | — | Position within the source (0-based) |
| `content` | TEXT | NO | — | The chunk text (~500 tokens) |
| `embedding` | VECTOR(3072) | YES | — | Gemini embedding for semantic search |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | Creation timestamp |

**Key indexes:**
- `idx_source_chunks_source_id` on `(source_id)`
- Vector index on `embedding` for cosine similarity search

---

## User Configuration Tables

### `user_profiles`

User identity and preferences injected into extraction prompts.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)`, UNIQUE |
| `professional_context` | JSONB | YES | `'{}'` | `{ role, industry, current_projects }` |
| `personal_interests` | JSONB | YES | `'{}'` | `{ topics, learning_goals }` |
| `processing_preferences` | JSONB | YES | `'{}'` | `{ insight_depth, relationship_focus }` |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | Auto-updated via trigger |

### `extraction_settings`

Default extraction preferences per user.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)`, UNIQUE |
| `default_mode` | VARCHAR(50) | YES | `'comprehensive'` | CHECK: comprehensive, strategic, actionable, relational |
| `default_anchor_emphasis` | VARCHAR(50) | YES | `'standard'` | CHECK: standard, aggressive, passive |
| `settings` | JSONB | YES | `'{}'` | Extensible settings blob |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | Auto-updated via trigger |

### `extraction_sessions`

Tracks each extraction for analytics and re-extraction.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `source_name` | VARCHAR(500) | YES | — | |
| `source_type` | VARCHAR(100) | YES | — | |
| `source_content_preview` | TEXT | YES | — | First 500 chars |
| `extraction_mode` | VARCHAR(50) | NO | — | Mode used for this extraction |
| `anchor_emphasis` | VARCHAR(50) | NO | — | Emphasis level used |
| `user_guidance` | TEXT | YES | — | Custom guidance provided |
| `selected_anchor_ids` | UUID[] | YES | — | Anchors selected for this extraction |
| `extracted_node_ids` | UUID[] | YES | — | IDs of nodes created |
| `extracted_edge_ids` | UUID[] | YES | — | IDs of edges created |
| `entity_count` | INTEGER | YES | `0` | |
| `relationship_count` | INTEGER | YES | `0` | |
| `extraction_duration_ms` | INTEGER | YES | — | Processing time |
| `feedback_rating` | INTEGER | YES | — | 1–5 scale, user feedback |
| `feedback_text` | TEXT | YES | — | |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |

---

## YouTube Automation Tables

### `youtube_channels`

User's subscribed YouTube channels for automated ingestion.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | References `auth.users(id)` |
| `channel_id` | VARCHAR(50) | NO | — | YouTube channel ID (UCxxxx) |
| `channel_name` | VARCHAR(255) | NO | — | |
| `channel_url` | TEXT | NO | — | |
| `thumbnail_url` | TEXT | YES | — | |
| `description` | TEXT | YES | — | |
| `subscriber_count` | INTEGER | YES | — | |
| `auto_ingest` | BOOLEAN | YES | `true` | |
| `extraction_mode` | VARCHAR(50) | YES | `'comprehensive'` | |
| `anchor_emphasis` | VARCHAR(50) | YES | `'standard'` | |
| `linked_anchor_ids` | UUID[] | YES | `'{}'` | |
| `custom_instructions` | TEXT | YES | — | |
| `min_video_duration` | INTEGER | YES | `90` | Seconds, skip Shorts |
| `max_video_duration` | INTEGER | YES | `NULL` | NULL = unlimited |
| `last_checked_at` | TIMESTAMPTZ | YES | — | |
| `last_video_published_at` | TIMESTAMPTZ | YES | — | |
| `total_videos_ingested` | INTEGER | YES | `0` | |
| `is_active` | BOOLEAN | YES | `true` | |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | |

UNIQUE constraint on `(user_id, channel_id)`.

### `youtube_playlists`

Connected YouTube playlists with Synapse codes.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | |
| `playlist_id` | VARCHAR(50) | NO | — | YouTube playlist ID |
| `playlist_url` | TEXT | NO | — | |
| `playlist_name` | VARCHAR(255) | YES | — | |
| `synapse_code` | VARCHAR(20) | YES | — | Format: SYN-XXXX |
| `linked_anchor_ids` | UUID[] | YES | `'{}'` | |
| `extraction_mode` | VARCHAR(50) | YES | `'comprehensive'` | |
| `anchor_emphasis` | VARCHAR(50) | YES | `'standard'` | |
| `custom_instructions` | TEXT | YES | — | |
| `known_video_count` | INTEGER | YES | `0` | |
| `status` | VARCHAR(50) | YES | `'active'` | active, paused, error |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | |

### `youtube_ingestion_queue`

Processing queue for video extraction jobs.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | |
| `channel_id` | UUID | NO | — | FK to `youtube_channels(id)`, ON DELETE CASCADE |
| `video_id` | VARCHAR(20) | NO | — | YouTube video ID |
| `video_title` | VARCHAR(500) | YES | — | |
| `video_url` | TEXT | NO | — | |
| `thumbnail_url` | TEXT | YES | — | |
| `published_at` | TIMESTAMPTZ | YES | — | |
| `duration_seconds` | INTEGER | YES | — | |
| `status` | VARCHAR(50) | YES | `'pending'` | pending, fetching_transcript, extracting, completed, failed, skipped |
| `priority` | INTEGER | YES | `5` | 1–10, lower = higher priority |
| `transcript` | TEXT | YES | — | Filled after tier 1/2/3 extraction |
| `transcript_language` | VARCHAR(10) | YES | — | |
| `transcript_fetched_at` | TIMESTAMPTZ | YES | — | |
| `source_id` | UUID | YES | — | FK to `knowledge_sources(id)` after extraction |
| `nodes_created` | INTEGER | YES | `0` | |
| `edges_created` | INTEGER | YES | `0` | |
| `error_message` | TEXT | YES | — | |
| `retry_count` | INTEGER | YES | `0` | |
| `max_retries` | INTEGER | YES | `3` | |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `started_at` | TIMESTAMPTZ | YES | — | |
| `completed_at` | TIMESTAMPTZ | YES | — | |

UNIQUE constraint on `(user_id, video_id)`.

### `youtube_settings`

Global YouTube automation settings per user.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | UNIQUE |
| `apify_api_key` | TEXT | YES | — | For tier 3 transcript extraction |
| `default_auto_ingest` | BOOLEAN | YES | `true` | |
| `default_extraction_mode` | VARCHAR(50) | YES | `'comprehensive'` | |
| `default_anchor_emphasis` | VARCHAR(50) | YES | `'standard'` | |
| `max_concurrent_extractions` | INTEGER | YES | `3` | |
| `max_videos_per_channel` | INTEGER | YES | `50` | Historical backfill limit |
| `daily_video_limit` | INTEGER | YES | `20` | |
| `videos_ingested_today` | INTEGER | YES | `0` | |
| `daily_limit_reset_at` | TIMESTAMPTZ | YES | — | |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | |

### `youtube_scan_history`

Audit log of scan/processing operations.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key |
| `user_id` | UUID | NO | — | |
| `channel_id` | UUID | YES | — | FK to `youtube_channels(id)`, ON DELETE SET NULL |
| `scan_type` | VARCHAR(50) | NO | — | manual_scan, auto_poll, process |
| `channel_name` | VARCHAR(255) | YES | — | Denormalized |
| `channel_youtube_id` | VARCHAR(50) | YES | — | |
| `videos_found` | INTEGER | YES | `0` | |
| `videos_added` | INTEGER | YES | `0` | |
| `videos_skipped` | INTEGER | YES | `0` | |
| `videos_processed` | INTEGER | YES | `0` | |
| `videos_failed` | INTEGER | YES | `0` | |
| `status` | VARCHAR(50) | YES | `'completed'` | completed, failed, partial |
| `error_message` | TEXT | YES | — | |
| `started_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `completed_at` | TIMESTAMPTZ | YES | — | |
| `duration_ms` | INTEGER | YES | — | |
| `metadata` | JSONB | YES | `'{}'` | |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |

---

## Digest / Orientation Engine Tables

> Note: These tables may not yet exist in the database. The Orientation Engine was spec'd but may need migration. Check before querying.

### `digest_profiles`

User-configured intelligence briefings.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `user_id` | UUID | |
| `title` | VARCHAR(255) | e.g., "Daily Morning Brief" |
| `frequency` | VARCHAR(50) | daily, weekly, monthly |
| `is_active` | BOOLEAN | |
| `schedule_time` | TIME | When to generate |
| `schedule_timezone` | VARCHAR(50) | |
| `density` | VARCHAR(50) | brief, standard, comprehensive |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### `digest_modules`

Individual intelligence-gathering sub-agents within a digest.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `digest_profile_id` | UUID | FK to `digest_profiles(id)` |
| `user_id` | UUID | |
| `template_id` | VARCHAR(100) | Which template module |
| `custom_context` | TEXT | User-provided context |
| `sort_order` | INTEGER | For drag-and-drop reordering |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |

---

## RLS Policy Pattern

Every table follows the same RLS pattern:

```sql
ALTER TABLE [table_name] ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own [table]"
  ON [table_name] FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own [table]"
  ON [table_name] FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own [table]"
  ON [table_name] FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own [table]"
  ON [table_name] FOR DELETE
  USING (auth.uid() = user_id);
```

---

## Common Query Patterns

### Fetch all anchors for the current user
```typescript
const { data } = await supabase
  .from('knowledge_nodes')
  .select('id, label, entity_type, description')
  .eq('is_anchor', true)
  .order('label');
```

### Semantic search on source chunks
```typescript
const { data } = await supabase.rpc('match_source_chunks', {
  query_embedding: embedding,
  match_threshold: 0.7,
  match_count: 10,
});
```

### Fetch node with its edges and neighbors
```typescript
// 1. Get edges
const { data: edges } = await supabase
  .from('knowledge_edges')
  .select('source_node_id, target_node_id, relation_type, evidence')
  .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);

// 2. Get neighbor node details
const neighborIds = new Set(edges.flatMap(e => [e.source_node_id, e.target_node_id]));
const { data: nodes } = await supabase
  .from('knowledge_nodes')
  .select('id, label, entity_type, description')
  .in('id', Array.from(neighborIds));
```

### Defensive INSERT (nullable fields)
```typescript
const payload: Record<string, any> = {
  user_id: userId,
  label: node.label,
  entity_type: node.entity_type,
};

// Only add optional fields if they have values
if (node.description) payload.description = node.description;
if (node.confidence != null) payload.confidence = node.confidence;
if (node.tags?.length) payload.tags = node.tags;
// Do NOT include empty arrays for UUID[] columns — let DB default handle it
if (node.source_id) payload.source_id = node.source_id;

const { data, error } = await supabase
  .from('knowledge_nodes')
  .insert(payload)
  .select('id')
  .maybeSingle();
```
