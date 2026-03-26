# PRD-24 — Synapse MCP Server & API Key Management

**Phase:** Phase 5 — Polish + Advanced  
**Dependencies:** PRD-7 (extraction pipeline), PRD-8 (Ask/Graph RAG pipeline), PRD-10 (Automate view)  
**Complexity:** High

---

## Objective

Expose Synapse's knowledge graph as a queryable MCP (Model Context Protocol) server so that external AI tools — primarily Claude Code — can call into the user's personal knowledge base at inference time. When a developer asks Claude Code a question about their work, domain, or prior decisions, Claude Code can invoke Synapse tools to retrieve graph-traversal-aware answers grounded in the user's actual ingested content.

The surface area is: a Vercel serverless endpoint implementing the MCP Streamable HTTP transport, a lightweight API key system for auth, and an "API & MCP Access" integration card added to the existing Automate view. No new views. No new nav items. The feature is discoverable exactly where other integrations live.

---

## What Gets Built

### New Files

| File | Purpose |
|---|---|
| `api/mcp.ts` | MCP server — Vercel serverless function, Streamable HTTP transport, all 6 tools |
| `api/keys/create.ts` | Generate a new API key, store hashed value in Supabase |
| `api/keys/list.ts` | Return all keys for the authenticated user (label, created, last used, id — never the raw key) |
| `api/keys/revoke.ts` | Delete a key by id |
| `supabase/migrations/20240001_synapse_api_keys.sql` | New `synapse_api_keys` table |
| `src/components/automate/McpAccessPanel.tsx` | Right panel content for the MCP integration card |
| `src/components/automate/ApiKeyRow.tsx` | Single row in the key list (label, dates, revoke button) |
| `src/components/automate/KeyRevealModal.tsx` | One-time key reveal modal shown immediately after creation |

### Modified Files

| File | Change |
|---|---|
| `src/views/AutomateView.tsx` | Add `mcp-access` integration card to the sources/connections list |
| `src/components/layout/RightPanel.tsx` | Add `mcp-access` case to the panel type switch |

---

## Supabase Migration

### Table: `synapse_api_keys`

```sql
create table synapse_api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  key_prefix  text not null,           -- first 12 chars of raw key, stored plaintext for display (e.g. "sk-syn-aBcD")
  key_hash    text not null,           -- sha-256 of full raw key, stored for verification
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

-- RLS
alter table synapse_api_keys enable row level security;
create policy "Users manage own keys"
  on synapse_api_keys for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast lookup during MCP auth
create index synapse_api_keys_hash_idx on synapse_api_keys(key_hash);
```

**Key format:** `sk-syn-` + 40 random base62 characters. Total: 47 chars.  
**Storage rule:** The raw key is shown once in the UI on creation, then discarded. Only `key_prefix` (first 12 chars including `sk-syn-`) and `key_hash` (SHA-256 of full key) are stored in the database. Verification is: `sha256(incoming_bearer) === stored_hash`.

---

## MCP Server — `api/mcp.ts`

### Protocol

Implements the **MCP Streamable HTTP transport** (spec version `2025-03-26`). This is a single POST endpoint. All MCP messages are JSON-RPC 2.0 sent as POST bodies. The server responds with `Content-Type: application/json` for non-streaming responses (all 6 tools return their full response synchronously, no streaming needed for lookup operations).

Claude Code configuration (user copies this from the UI):

```json
{
  "mcpServers": {
    "synapse": {
      "type": "http",
      "url": "https://<your-deployment>.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-syn-xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Authentication

Every request to `/api/mcp` must include `Authorization: Bearer <key>`. The handler:

1. Extracts the bearer token.
2. Computes `sha256(token)`.
3. Queries `synapse_api_keys` where `key_hash = computed_hash` (bypasses RLS — this is an unauthenticated route that validates via the key, not via Supabase JWT). Uses the service role key for this single lookup only.
4. If no matching row: returns `{"error": {"code": -32001, "message": "Unauthorized"}}` with HTTP 401.
5. If found: continues with `user_id` from the matching row. All subsequent Supabase queries use that `user_id` as a filter (manually applied, since there is no JWT session). Updates `last_used_at` asynchronously (fire-and-forget, does not block response).

### MCP Lifecycle Handlers

```
POST /api/mcp
  Body: { jsonrpc: "2.0", method: "...", params: {...}, id: ... }
```

| Method | Handler |
|---|---|
| `initialize` | Return server info: `{ name: "synapse", version: "1.0.0", protocolVersion: "2025-03-26" }` |
| `tools/list` | Return the 6 tool descriptors (see below) |
| `tools/call` | Dispatch to the appropriate tool handler by `params.name` |

All other methods return `{"error": {"code": -32601, "message": "Method not found"}}`.

### Tool Specifications

All tool handlers are defined inline within `api/mcp.ts` (Vercel self-containment constraint — no shared local imports). Supabase and Gemini clients are instantiated inline using env vars.

---

#### Tool 1: `ask_synapse`

**Description (shown to Claude Code for routing decisions):**
> Query the user's personal Synapse knowledge graph. Use this when the question involves the user's own knowledge, decisions, projects, relationships, or domain context — things learned from their meetings, documents, YouTube videos, or notes. This performs full graph-traversal RAG and returns a synthesised answer with source citations. Do NOT use for general world knowledge.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The question to answer using the user's personal knowledge graph."
    },
    "max_results": {
      "type": "number",
      "description": "Maximum number of source chunks to retrieve. Default 8, max 20.",
      "default": 8
    }
  },
  "required": ["query"]
}
```

**Implementation (inline in `api/mcp.ts`):**

Mirrors the Graph RAG pipeline from PRD-8. Steps:

1. Embed the query using Gemini `text-embedding-004` (`POST https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`).
2. Semantic search: call Supabase RPC `match_source_chunks` with the query embedding, `match_count = max_results`, filtered to `user_id`. Returns `{ id, content, source_id, similarity }[]`.
3. Keyword search: `SELECT id, label, description, entity_type, source_id FROM knowledge_nodes WHERE user_id = $1 AND (label ILIKE $2 OR description ILIKE $2) LIMIT 10` where `$2 = '%' + query_keywords + '%'`. Extract top 3 keywords by stripping stop words.
4. Merge results: deduplicate by source_id, score each chunk as `0.6 * semantic_similarity + 0.4 * keyword_score` (keyword_score is 1.0 if matched, 0 otherwise). Take top `max_results`.
5. Graph traversal: for each distinct `source_id` in top results, fetch connected anchor nodes: `SELECT kn.label, kn.entity_type, ke.relation_type FROM knowledge_edges ke JOIN knowledge_nodes kn ON (kn.id = ke.target_node_id OR kn.id = ke.source_node_id) WHERE (ke.source_node_id IN (...top_node_ids...) OR ke.target_node_id IN (...top_node_ids...)) AND kn.user_id = $1 AND kn.is_anchor = true LIMIT 20`.
6. Assemble context string:
   ```
   [Source Passages]
   {chunk content for each top chunk, prefixed with source title}

   [Key Entities & Connections]
   {anchor node labels + relation types}
   ```
7. Call Gemini `gemini-2.0-flash` (or `gemini-2.5-flash` once migrated): system prompt instructs it to answer based only on provided context, cite sources by title, note when information is missing. `temperature: 0.3`, `max_output_tokens: 1024`.
8. Return:
```json
{
  "answer": "...",
  "sources": [
    { "title": "...", "source_type": "...", "relevance": 0.87 }
  ],
  "entities_mentioned": ["Label1", "Label2"]
}
```

**Response format to MCP client:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "{answer}\n\n**Sources:**\n- Title1 (relevance: 87%)\n- Title2 (relevance: 71%)\n\n**Entities:** Label1, Label2"
    }
  ]
}
```

---

#### Tool 2: `search_entities`

**Description:**
> Search for specific entities (people, concepts, projects, decisions, etc.) in the user's knowledge graph. Returns matching nodes with their type, description, and connection count. Use when you need to look up a specific person, project, concept, or topic the user has encountered.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Name or description of the entity to find." },
    "entity_type": {
      "type": "string",
      "description": "Optional filter. One of: Person, Organization, Project, Concept, Decision, Insight, Topic, Technology, Goal, Risk, Action, Idea, Event, Location, Product, Metric, Hypothesis, Lesson, Takeaway, Question, Document, Team, Blocker, Anchor"
    },
    "limit": { "type": "number", "default": 10 }
  },
  "required": ["query"]
}
```

**Implementation:**

Hybrid search:
1. Embed query, semantic search on `knowledge_nodes.embedding` using RPC `match_knowledge_nodes` (if exists) or a direct pgvector query. Filtered by `user_id` and optionally `entity_type`.
2. Full-text fallback: `WHERE label ILIKE '%query%' OR description ILIKE '%query%'`.
3. Merge, deduplicate, take top `limit`.
4. For each result, fetch connection count: `SELECT COUNT(*) FROM knowledge_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND user_id = $2`.

**Return:**
```json
{
  "content": [{
    "type": "text",
    "text": "Found 3 entities:\n\n1. **Label** (Type) — Description. Connections: 12. Source: \"Meeting title\"\n2. ..."
  }]
}
```

---

#### Tool 3: `get_entity`

**Description:**
> Get full detail for a specific entity by its label, including all its direct connections and the sources it appears in. Use after search_entities to drill into a specific node.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "label": { "type": "string", "description": "Exact or approximate label of the entity." }
  },
  "required": ["label"]
}
```

**Implementation:**

1. `SELECT * FROM knowledge_nodes WHERE user_id = $1 AND label ILIKE $2 LIMIT 1` (closest match).
2. Fetch outbound edges: `SELECT ke.relation_type, ke.evidence, kn.label, kn.entity_type FROM knowledge_edges ke JOIN knowledge_nodes kn ON kn.id = ke.target_node_id WHERE ke.source_node_id = $1 AND ke.user_id = $2 LIMIT 20`.
3. Fetch inbound edges (same pattern, reversed).
4. Fetch source: `SELECT title, source_type FROM knowledge_sources WHERE id = $1`.

**Return:**
```json
{
  "content": [{
    "type": "text",
    "text": "**Label** (Type, confidence: 92%)\n\nDescription\n\nSource: \"Meeting title\"\n\nConnections:\n→ relates_to Label2 (evidence: ...)\n← supports Label3 (evidence: ...)"
  }]
}
```

---

#### Tool 4: `get_connections`

**Description:**
> Traverse the relationship network around a specific entity up to N hops. Shows how concepts, people, and projects are linked in the user's knowledge graph. Use to understand context and relationships around a topic.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "label": { "type": "string" },
    "hops": { "type": "number", "default": 2, "description": "How many relationship hops to traverse. Max 3." }
  },
  "required": ["label"]
}
```

**Implementation:**

Recursive traversal capped at `min(hops, 3)` levels. Use iterative BFS rather than recursive SQL to stay within Vercel timeout. At each level, fetch connected nodes and their edges. Accumulate a set of visited node IDs to prevent cycles. Cap total nodes returned at 30.

Format result as a readable tree:
```
Label (Type)
├─ relates_to → Label2 (Type2)
│   └─ supports → Label4 (Type4)
└─ blocks → Label3 (Type3)
```

---

#### Tool 5: `list_anchors`

**Description:**
> Return the user's anchor entities — the high-signal, recurring concepts and people that the user has designated as important. Anchors represent the core of the user's knowledge graph. Use to understand what the user considers most significant in their domain.

**Input schema:** `{}` (no parameters required)

**Implementation:**

```sql
SELECT kn.label, kn.entity_type, kn.description,
       COUNT(ke.id) as connection_count
FROM knowledge_nodes kn
LEFT JOIN knowledge_edges ke ON (ke.source_node_id = kn.id OR ke.target_node_id = kn.id)
WHERE kn.user_id = $1 AND kn.is_anchor = true
GROUP BY kn.id
ORDER BY connection_count DESC
LIMIT 30
```

Return as a formatted list grouped by entity type.

---

#### Tool 6: `get_recent_sources`

**Description:**
> List the most recently ingested content sources in the user's knowledge graph — meetings, YouTube videos, documents, and notes. Use to understand what the user has been learning about recently.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "limit": { "type": "number", "default": 10, "description": "Max number of sources to return." },
    "source_type": {
      "type": "string",
      "description": "Optional filter: youtube, meeting, document, note, web"
    }
  }
}
```

**Implementation:**

```sql
SELECT id, title, source_type, source_url, created_at,
       (SELECT COUNT(*) FROM knowledge_nodes WHERE source_id = ks.id AND user_id = $1) as node_count
FROM knowledge_sources ks
WHERE user_id = $1
  AND ($2::text IS NULL OR source_type = $2)
ORDER BY created_at DESC
LIMIT $3
```

---

## API Key Management Endpoints

These three Vercel functions are standard authenticated routes (JWT via Supabase `Authorization: Bearer <supabase_jwt>`). They are called from the Synapse frontend, not from external tools.

### `api/keys/create.ts`

**Method:** POST  
**Body:** `{ label: string }`  
**Auth:** Supabase JWT (user session)

**Logic:**
1. Validate label (1–50 chars, non-empty).
2. Generate raw key: `'sk-syn-' + randomBytes(30).toString('base64url').slice(0, 40)`.
3. Compute `key_hash = crypto.createHash('sha256').update(rawKey).digest('hex')`.
4. Extract `key_prefix = rawKey.slice(0, 12)`.
5. Insert into `synapse_api_keys`: `{ user_id, label, key_prefix, key_hash }`.
6. Return: `{ id, label, key_prefix, raw_key: rawKey, created_at }`.

The `raw_key` is returned **once only** in this response. The frontend shows it in `KeyRevealModal` and never requests it again.

### `api/keys/list.ts`

**Method:** GET  
**Auth:** Supabase JWT

```sql
SELECT id, label, key_prefix, created_at, last_used_at
FROM synapse_api_keys
WHERE user_id = $1
ORDER BY created_at DESC
```

Returns array — never includes `key_hash` or the raw key.

### `api/keys/revoke.ts`

**Method:** DELETE  
**Body:** `{ id: string }`  
**Auth:** Supabase JWT

```sql
DELETE FROM synapse_api_keys
WHERE id = $1 AND user_id = $2
```

Returns `{ success: true }`. If no row matched (wrong user or non-existent id), returns 404.

---

## Automate View — UI Integration

### Integration Card

The existing Automate view renders a list of integration cards (YouTube Channels, YouTube Playlists, Meeting Services, etc.). Add a new card for `mcp-access`.

**Card data entry (added to the integration constants array in `AutomateView.tsx`):**

```typescript
{
  id: 'mcp-access',
  category: 'api',
  title: 'API & MCP Access',
  description: 'Connect external AI tools to your knowledge graph',
  icon: 'plug',          // Lucide Plug2 icon
  iconColor: '#d63a00',  // accent-500, since this is a Synapse-native feature
}
```

**Card appearance:**

Matches the existing integration card pattern exactly:
- White card (`--bg-card`), `--border-subtle`, 16px 20px padding, 8px border-radius
- Left: icon container (28×28px, `--bg-inset` background, 7px radius, icon at 14px in `iconColor`) + title in Cabinet Grotesk 14px weight-600 + subtitle in DM Sans 12px `--text-secondary`
- Right: status indicator dot + label + secondary stat below

**Status logic:**

| State | Dot color | Label | Stat |
|---|---|---|---|
| No keys exist | `--text-secondary` (gray) | `not configured` | `0 keys` |
| 1+ keys exist | `#10b981` (green) | `active` | `{n} key{s}` |

**Click behavior:** Sets `selectedIntegrationId = 'mcp-access'`, which opens the right panel with `<McpAccessPanel />`.

---

### Right Panel — `McpAccessPanel.tsx`

The right panel (310px, white, `--border-subtle` left border) renders `McpAccessPanel` when the MCP card is selected.

#### Layout (top to bottom, 22px horizontal padding, 20px top padding)

**1. Panel header**
- Title: "API & MCP Access" — Cabinet Grotesk 14px weight-700 `--text-primary`
- Subtitle: "Connect Claude Code and other MCP-compatible tools to query your knowledge graph" — DM Sans 12px `--text-secondary`
- Divider: `--border-subtle` 1px horizontal rule, 16px vertical margin

**2. Setup instructions (collapsible, default open)**

Section label: "SETUP" (uppercase, Cabinet Grotesk 10px weight-700, `--text-secondary`, 0.08em tracking)

A code block (`--bg-inset`, 10px radius, 12px padding, 11px DM Sans monospace) showing the Claude Code config. The URL is populated dynamically from `window.location.origin`. The API key field shows a placeholder until a key is created.

```json
{
  "mcpServers": {
    "synapse": {
      "type": "http",
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

Copy button (Lucide `Copy` icon, 14px, ghost style) top-right of the code block. On copy: icon swaps to `Check` for 1.5s.

Config file path hint below: DM Sans 11px `--text-secondary` — "Add to `~/.claude.json` (global) or `.claude/claude.json` (per project)"

Divider, 16px vertical margin.

**3. API Keys section**

Section label: "YOUR API KEYS"

**If no keys exist:**
Empty state — centered, 40px top padding:
- Lucide `KeyRound` icon, 24px, `--text-secondary`
- "No API keys yet" — DM Sans 13px weight-600 `--text-primary`, 6px margin top
- "Create a key to connect external tools" — DM Sans 12px `--text-secondary`
- 16px gap, then "Generate API Key" button (primary style, accent-500, full-width, 36px height)

**If keys exist:**
List of `<ApiKeyRow />` components, gap 6px, followed by "Generate API Key" button (secondary style — `--text-primary` background, white text, full-width, 36px height). Maximum 10 keys per user (enforce in `api/keys/create.ts`; show inline error if limit reached).

**4. Available Tools section** (below the key list, always visible)

Section label: "AVAILABLE TOOLS"

A compact list of the 6 MCP tools, each row:
- Lucide `Zap` icon 12px `--text-secondary`
- Tool name in DM Sans 12px weight-600 `--text-primary`
- One-line description in DM Sans 11px `--text-secondary`
- 10px vertical padding, `--border-subtle` bottom border on all but last

| Tool | One-line description |
|---|---|
| `ask_synapse` | Full RAG query — answer questions from your knowledge graph |
| `search_entities` | Find entities (people, projects, concepts) by name or description |
| `get_entity` | Get full detail and connections for a specific entity |
| `get_connections` | Traverse relationship network N hops from an entity |
| `list_anchors` | Return your high-signal anchor entities |
| `get_recent_sources` | List recently ingested content |

---

### `ApiKeyRow.tsx`

Single key row in the list.

```
[key-icon] sk-syn-aBcD...  ·  "My label"                [Revoke]
           Created Mar 22, 2026  ·  Last used: 2h ago
```

- Icon: Lucide `Key` at 14px, `--text-secondary`
- Prefix: DM Sans 12px weight-600 monospace `--text-primary`
- Separator dot + label: DM Sans 12px `--text-secondary`
- Second line: DM Sans 11px `--text-secondary` — created date + last used (or "Never used" if `last_used_at` is null)
- Revoke button: Lucide `X` icon, 13px, ghost style in semantic red (`#ef4444`), appears on hover only (opacity-0 → opacity-100, 0.15s). On click: shows inline confirmation "Revoke this key? This cannot be undone." with red "Revoke" and gray "Cancel" — rendered as an inline replace of the row content, not a modal.

Padding: 12px 0. `--border-subtle` bottom border. No card/box around individual rows — they sit as a simple list.

---

### `KeyRevealModal.tsx`

Shown immediately after a key is created. Rendered as a centered overlay (not full-screen — constrained to the right panel width, positioned above the panel content).

```
┌────────────────────────────────────┐
│  🔑  API Key Created               │
│                                    │
│  Copy this key now. It will not    │
│  be shown again.                   │
│                                    │
│  sk-syn-aBcDeFgHiJkLmNoPqRsTuVwXy │  [Copy]
│                                    │
│  Label: "My label"                 │
│                                    │
│  [  I've copied my key  ]          │
└────────────────────────────────────┘
```

- Background: white `--bg-card`, `--border-strong` 1px border, 12px radius, 24px padding
- Title: Cabinet Grotesk 14px weight-700
- Warning text: DM Sans 13px `--text-body`
- Key display: `--bg-inset` block, 11px DM Sans monospace, full width. Copy button (Lucide `Copy`) right-aligned within the block. On copy: check icon + "Copied!" for 1.5s.
- "I've copied my key" button: primary accent-500, full-width. Clicking dismisses the modal and updates the key list (the newly created key row appears without the raw key — only the prefix).

---

## Hook: `useApiKeys`

Location: `src/hooks/useApiKeys.ts`

```typescript
interface ApiKey {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

interface UseApiKeysReturn {
  keys: ApiKey[];
  loading: boolean;
  error: string | null;
  createKey: (label: string) => Promise<{ rawKey: string; key: ApiKey } | null>;
  revokeKey: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}
```

- Calls `GET /api/keys/list` on mount (with Supabase JWT in auth header).
- `createKey` calls `POST /api/keys/create`, returns `{ rawKey, key }` for the modal.
- `revokeKey` calls `DELETE /api/keys/revoke`, optimistically removes the row from local state.
- All requests include `Authorization: Bearer ${session.access_token}` from Supabase auth session.

---

## Interaction & State

**Key creation flow:**
1. User clicks "Generate API Key" → a small inline form appears below the button: a text input ("Key label — e.g. Claude Code Work") + "Create" button + "Cancel" link.
2. Input validates on blur: 1–50 chars, non-empty. Shows inline error if invalid.
3. On "Create": button shows spinner, calls `createKey(label)`. On success: `KeyRevealModal` appears with the raw key.
4. After user clicks "I've copied my key": modal closes, new `ApiKeyRow` appears in the list, inline form hides.

**Revoke flow:**
1. User hovers a key row — revoke ×-button fades in.
2. Click → inline confirmation replaces row content.
3. "Revoke" click: calls `revokeKey(id)`, optimistically removes row. If API fails, row re-appears with error toast.

**Panel state persistence:** `selectedIntegrationId` lives in `AutomateView` local state — it resets on view navigation (standard pattern per existing Automate behavior).

**Code block copy:** Copies the full JSON config block to clipboard. If no keys exist yet, the `Bearer` value is `<your-api-key>` literal. If exactly one key exists, it pre-fills the prefix + `...` as a hint (but never the full key). If multiple keys, uses `<your-api-key>`.

---

## Forward-Compatible Decisions

- **Key auth pattern in `api/mcp.ts` is reusable** for any future external API endpoints (webhooks, future REST API, agent orchestration endpoints). The `verifyApiKey(req) → { userId } | null` inline function is the canonical pattern.
- **Tool list is designed for extension.** New tools (e.g., `ingest_note`, `get_digest`) can be added as new cases in the `tools/call` dispatcher without touching existing tools. The tool descriptor array is defined at the top of the file for easy modification.
- **Gemini model string is env-var controlled** (`process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'`) in `api/mcp.ts`, so the planned 2.5 Flash migration requires no code change — just an env var update in Vercel.
- **The `mcp-access` card category (`'api'`) is a new integration category** in the Automate view. This category can house future API-type integrations (REST webhooks, Zapier, etc.) without restructuring the filter pills.

---

## Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| MCP request with invalid/missing bearer token | HTTP 401, JSON-RPC error code -32001, message "Unauthorized" |
| MCP request with valid key but revoked since request started | HTTP 401 (key lookup fails) |
| `ask_synapse` with no source_chunks (empty knowledge base) | Return graceful answer: "Your knowledge graph doesn't have enough content to answer this yet. Try ingesting some sources in Synapse first." |
| `ask_synapse` with Gemini API failure | Return error in tool content: `{ "content": [{ "type": "text", "text": "Unable to generate answer: Gemini API error. Source chunks retrieved: [list titles]" }] }` |
| `tools/call` with unknown tool name | JSON-RPC error -32602: "Unknown tool: {name}" |
| `api/keys/create` called when user already has 10 keys | HTTP 400: `{ error: "Maximum of 10 API keys allowed. Revoke an existing key to create a new one." }` |
| `api/keys/create` with empty or oversized label | HTTP 400: `{ error: "Label must be between 1 and 50 characters." }` |
| Supabase connection failure in MCP handler | HTTP 500, JSON-RPC error -32603: "Internal error" — do not expose connection details |
| Vercel function timeout (10s free tier) | `ask_synapse` is the only tool at risk. Add a 8s hard timeout wrapper around the Gemini call; if it fires, return partial result with whatever chunks were retrieved. |
| Key reveal modal closed accidentally (ESC, click-outside) | Modal does not close on ESC or backdrop click. Only the explicit "I've copied my key" button closes it. This prevents accidental loss of the one-time key. |
| `revokeKey` API failure after optimistic UI update | Re-insert the key row, show toast: "Failed to revoke key. Please try again." |
| User on free Vercel tier (10s timeout) | Document in the Setup section of the panel: "Note: complex queries may time out on Vercel's free tier. Upgrade to Vercel Pro for 60s function timeout." |

---

## Acceptance Criteria

- A user can navigate to Automate, see the "API & MCP Access" integration card with correct status (gray/inactive if no keys, green/active if keys exist).
- Clicking the card opens the right panel showing the setup config block, an empty key list state, and the 6 available tools.
- A user can click "Generate API Key", enter a label, and receive a key via the reveal modal. The key is in `sk-syn-` format.
- The reveal modal cannot be dismissed by ESC or backdrop click — only the copy-confirmation button.
- After creation, the key row appears in the list showing the prefix, label, creation time, and "Never used".
- A user can hover a key row and click × to trigger inline confirmation, then revoke the key. The row is removed from the list.
- The copy button on the config block copies valid JSON to clipboard. If a key exists, it does not pre-fill the raw key value.
- `POST /api/mcp` with no auth header returns HTTP 401.
- `POST /api/mcp` with a valid bearer token returns the MCP `initialize` handshake correctly.
- `tools/list` returns all 6 tool descriptors with correct names and input schemas.
- `tools/call` with `ask_synapse` and a real query returns a synthesised answer with sources listed.
- `tools/call` with `list_anchors` returns the user's anchor nodes.
- `tools/call` with `search_entities` returns matching nodes.
- `last_used_at` on the key row updates after a successful MCP tool call.
- After adding the config to `~/.claude.json` and restarting Claude Code, the `synapse` MCP server appears in the available tools list and `ask_synapse` can be invoked.
