# Send to Synapse — Session Ingestion from Claude Code

**Date:** 2026-04-15
**Status:** Approved
**Scope:** New MCP write tool + Vercel serverless endpoint + Claude Code skill

---

## Problem

Claude Code sessions produce valuable knowledge — insights, decisions, technical advancements, research findings, skill applications — that currently evaporates when the session ends. There is no way to capture this knowledge into the Synapse knowledge graph, where it could be connected to existing entities, searched via RAG, and surfaced in digests.

## Solution

A three-part system that lets users send structured session summaries from Claude Code into Synapse with a single command:

1. **Claude Code skill** (`/synapse`) — generates a structured markdown summary from the conversation context
2. **MCP tool** (`send_to_synapse`) — delivers the markdown to Synapse via the existing MCP server
3. **Vercel endpoint** (`api/ingest/session.ts`) — saves the source and triggers the full extraction pipeline

---

## Architecture

```
User triggers /synapse [optional guidance]
        │
        ▼
Claude Code Skill (prompt template)
   - Reviews full conversation context
   - Applies structured markdown template
   - Incorporates user guidance if provided
   - Auto-generates title, detects repo + branch
        │
        ▼
MCP Tool: send_to_synapse
   - Validates API key (existing auth)
   - POSTs to api/ingest/session.ts
        │
        ▼
Vercel Endpoint: api/ingest/session.ts
   - Creates knowledge_sources row (source_type: 'GitHub')
   - Triggers full extraction pipeline:
     1. Generate summary (Gemini)
     2. Extract entities (Gemini, comprehensive mode, aggressive anchors)
     3. Save nodes + edges (with deduplication)
     4. Generate embeddings (text-embedding-004)
     5. Chunk source content (for RAG)
     6. Discover cross-connections
        │
        ▼
Knowledge graph updated — entities, relationships, embeddings, chunks
```

---

## Component 1: Claude Code Skill — `/synapse`

### File Location

Installed as a Claude Code skill file (markdown). Exact path depends on user's skill installation method (global or project-level).

### Trigger

- Explicit: `/synapse [optional guidance text]`
- Conversational: "Send this to Synapse", "Save this session to my knowledge graph", etc.

### Behaviour

1. If guidance is provided, note it for emphasis in the summary
2. Review the full conversation context
3. Apply the markdown template (see below)
4. Auto-generate a concise, descriptive title from the session content
5. Detect repo name and branch from the current working directory
6. Omit any template sections with no relevant content (no empty headers)
7. If guidance was provided, add a "User Guidance Notes" section explaining what was emphasised
8. Call the `send_to_synapse` MCP tool with the finished markdown + metadata
9. Confirm to the user: title, source ID, and that extraction has been triggered

### Markdown Template

```markdown
# Session: [Auto-generated title]
**Date:** [YYYY-MM-DD]
**Repo:** [repository name]
**Branch:** [branch name]

## Summary
[2-3 sentence overview of what this session covered]

## Key Insights
- [Insight with context]

## Topics Covered
- [Topic with brief context on what was discussed]

## Decisions Made
- [Decision and the reasoning behind it]

## Technical Advancements
- [What was built, fixed, or changed — with file paths where relevant]

## Skills & Methodologies Referenced
- [Any frameworks, patterns, or approaches that were applied]

## Updates & Status Changes
- [State changes — what moved forward, what's complete, what's blocked]

## Action Items
- [Outstanding follow-ups or next steps]

## User Guidance Notes
[Only present if user provided guidance. Captures what they asked to emphasise and what was found.]
```

### Template Rules

- Sections with no relevant content are omitted entirely (no empty headers)
- Each bullet point should be self-contained and meaningful for entity extraction
- Include file paths, function names, and technical specifics where relevant (these become entity candidates)
- Reference people, organisations, projects, and concepts by name (these connect to existing graph nodes)
- The summary section should read like a standalone briefing of the session

---

## Component 2: MCP Tool — `send_to_synapse`

### Location

Added to existing `api/mcp.ts` alongside the 15 read-only tools.

### Tool Definition

```typescript
{
  name: 'send_to_synapse',
  description: 'Send a structured session summary from Claude Code into the Synapse knowledge graph. Creates a GitHub source and triggers the full extraction pipeline (entity extraction, embeddings, cross-connections). Use this after generating a session summary with the /synapse skill.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Concise descriptive title for the session (like a commit message for the conversation).'
      },
      content: {
        type: 'string',
        description: 'Full structured markdown summary of the session.'
      },
      repo: {
        type: 'string',
        description: 'Repository name (auto-detected from working directory).'
      },
      branch: {
        type: 'string',
        description: 'Git branch name at time of session.'
      },
      guidance: {
        type: 'string',
        description: 'User-provided instructions that shaped the summary. Stored in metadata and passed as custom extraction guidance.'
      }
    },
    required: ['title', 'content']
  }
}
```

### Handler Behaviour

1. Authenticate request using existing `sk-syn-*` API key validation
2. Resolve `userId` from the API key (existing pattern)
3. POST to `api/ingest/session.ts` with: `{ userId, title, content, repo, branch, guidance }`
4. Return response to caller:

```json
{
  "content": [{
    "type": "text",
    "text": "Session saved to Synapse.\n\nSource ID: <uuid>\nTitle: <title>\nStatus: Extraction pipeline triggered.\n\nEntities and relationships will appear in your knowledge graph shortly."
  }]
}
```

### Error Handling

- If the ingest endpoint fails, return a clear error message (not a generic 500)
- If content is empty or title is missing, return validation error before calling the endpoint

---

## Component 3: Vercel Endpoint — `api/ingest/session.ts`

### Route

`POST /api/ingest/session`

### Authentication

Internal call from MCP server only. Validated by checking a shared secret header (`x-ingest-secret`) that matches a server-side environment variable. Not exposed to public callers.

### Request Body

```typescript
interface SessionIngestRequest {
  userId: string        // UUID from MCP auth
  title: string         // Session title
  content: string       // Full markdown summary
  repo?: string         // Repository name
  branch?: string       // Git branch
  guidance?: string     // User's custom extraction guidance
}
```

### Processing Steps

**Step 1 — Save source**

Insert into `knowledge_sources`:

| Field | Value |
|-------|-------|
| `user_id` | from request |
| `title` | from request |
| `content` | full markdown |
| `source_type` | `'GitHub'` |
| `source_url` | null |
| `metadata` | `{ ingested_via: 'mcp_session', repo, branch, guidance, session_date }` |
| `participants` | null |

**Step 2 — Generate summary**

Call Gemini `gemini-2.0-flash` to produce a 2-3 sentence summary of the markdown. Update the source row with `summary` and `summary_source: 'generated'`.

**Step 3 — Extract entities**

Call Gemini with:
- **Mode:** `comprehensive`
- **Anchor emphasis:** `aggressive`
- **Custom guidance:** the `guidance` field from the request (if provided)
- **Content:** the full markdown

Returns structured entities (nodes) and relationships (edges).

**Step 4 — Save nodes + edges**

- Run deduplication against existing nodes (same user, same label, same entity type)
- Insert new nodes into `knowledge_nodes`
- Insert edges into `knowledge_edges`
- Link all nodes to the source via `source_id`

**Step 5 — Generate embeddings**

Generate Gemini `text-embedding-004` embeddings (768-dim) for each new node. Update `knowledge_nodes` with embedding vectors.

**Step 6 — Chunk source content**

Split the markdown into chunks (same chunking logic as other sources). Insert into `knowledge_source_chunks` with embeddings for RAG search.

**Step 7 — Discover cross-connections**

Run cross-connection discovery to find relationships between entities in this session and entities from other sources in the user's graph.

### Response

```json
{
  "source_id": "uuid",
  "title": "string",
  "entity_count": 42,
  "edge_count": 67,
  "status": "complete"
}
```

### Error Handling

- If any step fails, return the step name and error message
- Source is still saved even if extraction fails (can be retried)
- Vercel 60-second timeout is sufficient for typical session summaries (2,000-5,000 words)

### Critical Constraint

This is a self-contained Vercel serverless function. No local imports from `src/`. All helpers must be defined inline or imported from npm packages. This follows the existing pattern for all files in `api/`.

---

## New Source Type: GitHub

### Addition to Source Type Config

Add to `src/config/sourceTypes.ts`:

```typescript
GitHub: { color: '#24292e', icon: GitBranch, label: 'GitHub' }
```

### Addition to Type Definitions

Update `src/types/database.ts`:

```typescript
export type SourceType = 'Meeting' | 'YouTube' | 'Research' | 'Note' | 'Document' | 'GitHub'
```

### UI Impact

- GitHub sources will appear in Recent Sources, Explore, and Pipeline views with the GitHub icon and dark color
- Existing filters that use `source_type` will automatically include GitHub sources
- No new UI components needed — GitHub sources render the same as any other source type

---

## Environment Variables

One new variable needed:

| Variable | Purpose | Where |
|----------|---------|-------|
| `INGEST_SECRET` | Shared secret between MCP server and ingest endpoint | Vercel env vars |

The MCP server already has access to `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GEMINI_API_KEY`.

---

## Files Changed / Created

| File | Action | Description |
|------|--------|-------------|
| `api/mcp.ts` | Modified | Add `send_to_synapse` tool definition and handler |
| `api/ingest/session.ts` | **New** | Serverless endpoint: save source + run extraction pipeline |
| `src/config/sourceTypes.ts` | Modified | Add `GitHub` source type config |
| `src/types/database.ts` | Modified | Add `'GitHub'` to `SourceType` union |
| Skill file (external) | **New** | `/synapse` Claude Code skill with prompt template |

---

## What This Does NOT Include

- No changes to existing MCP read tools
- No changes to the extraction pipeline logic itself (uses existing patterns)
- No new UI views or components (GitHub sources use existing rendering)
- No changes to the database schema (uses existing tables)
- No batch/bulk ingestion (one session at a time)
