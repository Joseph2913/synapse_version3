# PRD: Synapse MCP Tool Improvements

**PRD Number:** MCP-1
**Phase:** Infrastructure — MCP Server Layer
**Dependencies:** Participants column migration (standalone prompt provided separately)
**Estimated Complexity:** High (4 new tools, 3 parameter additions, 2 response quality improvements)

---

## 1. Objective

The Synapse MCP server is the primary interface through which Claude (and future AI agents) access a user's personal knowledge graph. A comparative analysis between raw transcript review and MCP-assisted retrieval revealed that the MCP layer — while strong at cross-source entity discovery — has critical gaps in temporal retrieval, raw content access, source-level search, and structured meeting intelligence output. These gaps force users into manual multi-tool-call workarounds or, worse, into bypassing the MCP entirely in favor of pasting raw transcripts.

This PRD closes those gaps by adding four new tools, extending three existing tools with missing parameters, and improving response consistency across all source-returning tools. Every change operates on existing database columns and indexes (plus the one new `participants TEXT[]` column being added via a separate migration). Zero schema changes are introduced by this PRD itself.

After this PRD, a user should be able to say "pull up my IQVIA meeting from Tuesday, give me the full transcript, show me the action items, and tell me what other meetings are related" — and the MCP should handle that in 2–3 tool calls, not 8+.

---

## 2. Context: What the Comparative Analysis Found

The analysis compared two approaches for extracting meeting intelligence from a March 25, 2026 IQVIA debrief:

**Where the MCP won:**
- Cross-meeting threading (connected 4+ related meetings into a narrative arc)
- Entity discovery (surfaced "Death by Prompts" concept from a different source)
- Historical backstory (prior meeting failures, strategy pivots)

**Where the MCP lost:**
- Could not find the meeting by date (no date filter parameters existed)
- Could not return the actual transcript (no raw content access tool)
- Lost distinctive framings, reasoning chains, and speaker-specific language
- Required 8+ sequential tool calls to assemble a comparable picture
- Participant-based queries impossible ("meetings with Antonio")

**Root causes (all at the MCP layer, not the database):**
- `get_recent_sources` had no date filter parameters despite `created_at` being indexed
- No tool exposed the `knowledge_sources.content` column (full transcript)
- No compound query tool assembled meeting intelligence from multiple entity types
- No tool traversed cross-source edges to find related sources
- No source-level search tool existed (only entity search and RAG)

---

## 3. What Gets Built

### A. New Tools

#### A1. `get_source_content`

**Purpose:** Retrieve the full raw content of a source (transcript, article, notes) plus its metadata. This is the single highest-impact addition — it unlocks the transcript-based workflow that the comparative analysis proved superior for downstream deliverables like slide generation.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | Yes | — | Search term to match against source titles. Fuzzy matching (case-insensitive, partial match). |
| `source_id` | string (UUID) | No | — | Direct lookup by source ID. If provided, `query` is ignored. |
| `include_content` | boolean | No | `true` | Whether to return the full `content` field. Set to `false` for metadata-only lookups. |
| `max_content_length` | number | No | `50000` | Truncate content at this character count. Safety valve for very long transcripts. |

**Returns:**

```typescript
{
  source_id: string;
  title: string;
  source_type: string;           // Meeting, YouTube, Research, Note, Document
  source_url: string | null;
  created_at: string;            // ISO datetime
  participants: string[] | null; // From new participants column
  metadata: Record<string, any>; // JSONB metadata
  content: string | null;        // Full raw content (transcript, article, etc.)
  content_length: number;        // Total character count before truncation
  content_truncated: boolean;    // Whether content was truncated
  entity_count: number;          // COUNT of knowledge_nodes with this source_id
  chunk_count: number;           // COUNT of source_chunks with this source_id
}
```

**Query logic:**
1. If `source_id` is provided: direct lookup by ID on `knowledge_sources`
2. If `query` is provided: `SELECT ... FROM knowledge_sources WHERE LOWER(title) LIKE LOWER('%' || query || '%') ORDER BY created_at DESC LIMIT 1`
3. If multiple matches, return the most recent (by `created_at`)
4. Entity count: `SELECT COUNT(*) FROM knowledge_nodes WHERE source_id = :id`
5. Chunk count: `SELECT COUNT(*) FROM source_chunks WHERE source_id = :id`

**Error cases:**
- No matching source found → return `null` with a message suggesting alternate search terms
- Content exceeds `max_content_length` → truncate and set `content_truncated: true`

---

#### A2. `get_meeting_brief`

**Purpose:** Assemble a structured meeting intelligence brief from existing extracted data. This is the compound query that replaces the 8+ manual tool calls the comparative analysis required. No Gemini call needed — pure database assembly.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | Yes | — | Meeting title or search term. Fuzzy matched against `knowledge_sources.title` where `source_type = 'Meeting'`. |
| `source_id` | string (UUID) | No | — | Direct lookup. If provided, `query` is ignored. |

**Returns:**

```typescript
{
  // Meeting metadata
  meeting: {
    source_id: string;
    title: string;
    created_at: string;
    participants: string[] | null;
    source_url: string | null;
    metadata: Record<string, any>;
    duration: string | null;       // Extracted from metadata if available
  };

  // Entities grouped by function
  decisions: Array<{
    label: string;
    description: string;
    confidence: number;
    quote: string | null;          // Direct quote from source supporting this
  }>;

  action_items: Array<{
    label: string;
    description: string;
    confidence: number;
    quote: string | null;
  }>;

  key_insights: Array<{           // Insight + Concept + Lesson + Takeaway entities
    label: string;
    entity_type: string;
    description: string;
    confidence: number;
    quote: string | null;
  }>;

  topics_discussed: Array<{       // Topic entities
    label: string;
    description: string;
  }>;

  people_mentioned: Array<{       // Person entities from this source
    label: string;
    description: string;
  }>;

  risks_and_blockers: Array<{     // Risk + Blocker entities
    label: string;
    entity_type: string;
    description: string;
  }>;

  // Cross-source connections
  related_sources: Array<{
    source_id: string;
    title: string;
    source_type: string;
    created_at: string;
    shared_entity_count: number;
    shared_entities: Array<{
      label: string;
      entity_type: string;
      relation_type: string;       // The edge relation connecting them
    }>;
  }>;

  // Summary stats
  total_entities_extracted: number;
  total_edges: number;
}
```

**Query logic:**
1. Find the meeting source (same logic as `get_source_content` query matching, filtered to `source_type = 'Meeting'`)
2. Fetch all `knowledge_nodes` where `source_id` matches, grouped by `entity_type`:
   - `entity_type = 'Decision'` → `decisions`
   - `entity_type = 'Action'` → `action_items`
   - `entity_type IN ('Insight', 'Concept', 'Lesson', 'Takeaway')` → `key_insights`
   - `entity_type = 'Topic'` → `topics_discussed`
   - `entity_type = 'Person'` → `people_mentioned`
   - `entity_type IN ('Risk', 'Blocker')` → `risks_and_blockers`
3. For related sources:
   a. Get all node IDs from this source: `SELECT id FROM knowledge_nodes WHERE source_id = :id`
   b. Find edges connecting these nodes to nodes from other sources:
      ```sql
      SELECT DISTINCT ON (other_nodes.source_id)
        other_nodes.source_id,
        other_nodes.label,
        other_nodes.entity_type,
        edges.relation_type
      FROM knowledge_edges edges
      JOIN knowledge_nodes this_nodes ON (
        edges.source_node_id = this_nodes.id OR edges.target_node_id = this_nodes.id
      )
      JOIN knowledge_nodes other_nodes ON (
        (edges.source_node_id = other_nodes.id OR edges.target_node_id = other_nodes.id)
        AND other_nodes.source_id != :source_id
        AND other_nodes.id != this_nodes.id
      )
      WHERE this_nodes.source_id = :source_id
      ```
   c. Group by `other_nodes.source_id`, count shared entities, join to `knowledge_sources` for title and metadata
   d. Order by `shared_entity_count DESC`, limit to top 10

**Error cases:**
- No matching meeting found → return `null` with suggestion to use `search_sources` to find the correct title
- Meeting found but no entities extracted → return meeting metadata with empty arrays and a note that extraction may not have completed

---

#### A3. `get_related_sources`

**Purpose:** Given a source, find other sources that share entities or connections with it. This surfaces the cross-meeting threading that the comparative analysis identified as Synapse's unique compounding value.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | Yes | — | Source title or search term. |
| `source_id` | string (UUID) | No | — | Direct lookup. If provided, `query` is ignored. |
| `source_type` | string | No | — | Filter related sources by type (Meeting, YouTube, etc.). |
| `limit` | number | No | `10` | Max related sources to return. |

**Returns:**

```typescript
{
  source: {
    source_id: string;
    title: string;
    source_type: string;
    created_at: string;
  };

  related_sources: Array<{
    source_id: string;
    title: string;
    source_type: string;
    created_at: string;
    participants: string[] | null;
    shared_entity_count: number;
    shared_entities: Array<{
      label: string;
      entity_type: string;
      relation_type: string;
    }>;
    relevance_summary: string;    // e.g., "Shares 4 entities: Antonio Pregueiro (Person), IQVIA Field Force Agent (Product), Sales Simulator Tool (Technology), Death by Prompts (Concept)"
  }>;
}
```

**Query logic:** Same cross-source edge traversal as `get_meeting_brief` step 3, but exposed as a standalone tool for any source type — not just meetings.

**Error cases:**
- Source not found → return `null`
- Source found but no cross-source connections → return source metadata with empty `related_sources` array and a note explaining this source has no discovered connections to other sources yet

---

#### A4. `search_sources`

**Purpose:** A proper source-level search combining keyword matching with filters for type, date range, and participants. This is the "find me the meeting about IQVIA" or "meetings with Antonio last week" tool.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | No | — | Keyword search against `title` and `content`. If omitted, returns all sources matching other filters. |
| `source_type` | string | No | — | Filter by source type: Meeting, YouTube, Research, Note, Document. |
| `date_from` | string (ISO date) | No | — | Sources with `created_at` >= this date. |
| `date_to` | string (ISO date) | No | — | Sources with `created_at` <= this date. |
| `participant` | string | No | — | Filter to sources where `participants` array contains this name (case-insensitive partial match using array element `ILIKE`). |
| `limit` | number | No | `10` | Max results. |
| `sort` | string | No | `'recent'` | Sort order: `'recent'` (created_at DESC) or `'relevant'` (keyword match quality). |

**Returns:**

```typescript
Array<{
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  created_at: string;
  participants: string[] | null;
  metadata: Record<string, any>;
  entity_count: number;
  content_preview: string;        // First 300 characters of content
}>
```

**Query logic:**

```sql
SELECT
  ks.id AS source_id,
  ks.title,
  ks.source_type,
  ks.source_url,
  ks.created_at,
  ks.participants,
  ks.metadata,
  LEFT(ks.content, 300) AS content_preview,
  (SELECT COUNT(*) FROM knowledge_nodes kn WHERE kn.source_id = ks.id) AS entity_count
FROM knowledge_sources ks
WHERE ks.user_id = auth.uid()
  AND (:source_type IS NULL OR ks.source_type = :source_type)
  AND (:date_from IS NULL OR ks.created_at >= :date_from)
  AND (:date_to IS NULL OR ks.created_at <= :date_to)
  AND (:participant IS NULL OR EXISTS (
    SELECT 1 FROM unnest(ks.participants) AS p
    WHERE p ILIKE '%' || :participant || '%'
  ))
  AND (:query IS NULL OR (
    ks.title ILIKE '%' || :query || '%'
    OR ks.content ILIKE '%' || :query || '%'
  ))
ORDER BY
  CASE WHEN :sort = 'recent' THEN ks.created_at END DESC,
  CASE WHEN :sort = 'relevant' THEN
    CASE WHEN ks.title ILIKE '%' || :query || '%' THEN 1 ELSE 2 END
  END ASC,
  ks.created_at DESC
LIMIT :limit;
```

**Error cases:**
- No results → return empty array with a message suggesting broader filters
- No filters provided at all → return most recent 10 sources (same as `get_recent_sources` default)

---

### B. Parameter Additions to Existing Tools

#### B1. `get_recent_sources` — Add Date Filters

**Current parameters:** `limit`, `source_type`

**Add:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date_from` | string (ISO date) | No | — | Sources with `created_at` >= this date. |
| `date_to` | string (ISO date) | No | — | Sources with `created_at` <= this date. |

**Implementation:** Add WHERE clauses to the existing query:
```sql
AND (:date_from IS NULL OR created_at >= :date_from)
AND (:date_to IS NULL OR created_at <= :date_to)
```

**Why:** The comparative analysis showed that "find me meetings from yesterday" failed entirely — not because the data was missing, but because the tool had no mechanism to filter by date. `created_at` is already indexed and is a good-enough proxy for event date (meetings are typically ingested same-day).

---

#### B2. `ask_synapse` — Add Source Scoping

**Current parameters:** `query`, `max_results`

**Add:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `source_ids` | string[] (UUIDs) | No | — | Constrain RAG search to chunks from these specific sources only. |
| `source_type` | string | No | — | Constrain RAG search to chunks from sources of this type only. |

**Implementation:** The `match_source_chunks` RPC function (or the query that calls it) needs to add a filter:
```sql
AND (:source_ids IS NULL OR sc.source_id = ANY(:source_ids))
AND (:source_type IS NULL OR EXISTS (
  SELECT 1 FROM knowledge_sources ks
  WHERE ks.id = sc.source_id AND ks.source_type = :source_type
))
```

If `match_source_chunks` is an existing RPC that can't easily be modified, create a new RPC `match_source_chunks_scoped` with the additional parameters.

**Why:** "Summarize the IQVIA meeting" should search only within that meeting's chunks, not the entire graph. Without source scoping, the RAG pipeline searches globally and the answer is diluted by tangentially related content from other sources. The comparative analysis showed that source-scoped queries produce much more precise results.

---

#### B3. `search_entities` — Add Source Scoping

**Current parameters:** `query`, `entity_type`, `limit`

**Add:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `source_id` | string (UUID) | No | — | Filter entities to those extracted from this specific source. |

**Implementation:** Add WHERE clause:
```sql
AND (:source_id IS NULL OR source_id = :source_id)
```

**Why:** "What entities were extracted from the IQVIA meeting?" currently returns every entity matching the keyword "IQVIA" across all sources. Source scoping makes this precise.

---

### C. Response Quality Improvements

#### C1. Consistent Metadata on All Source-Returning Tools

Every tool that returns source information must consistently include these fields in its response:

| Field | Description |
|---|---|
| `source_id` | UUID |
| `title` | Source title |
| `source_type` | Meeting, YouTube, Research, Note, Document |
| `created_at` | ISO datetime string |
| `participants` | `string[]` or `null` (from new column) |
| `entity_count` | Count of `knowledge_nodes` with this `source_id` |
| `source_url` | Original URL or `null` |

**Applies to:** `get_recent_sources`, `get_source_content`, `search_sources`, `get_related_sources`, `get_meeting_brief`

Currently `get_recent_sources` returns some of these but not all, and the format is inconsistent with what other tools will return. Standardize the response shape so Claude can work with source data uniformly regardless of which tool retrieved it.

---

#### C2. `get_entity` — Include Source Content Context

**Current response:** Entity details (label, type, description, connections).

**Add to response:**

| Field | Description |
|---|---|
| `quote` | The `knowledge_nodes.quote` field — direct quote from source supporting this entity |
| `source_excerpt` | A ~200-character excerpt from the `source_chunks` entry most relevant to this entity (fetched via embedding similarity between the entity's embedding and the source's chunks, limited to chunks from the same `source_id`) |
| `source_title` | Title of the source this entity was extracted from |
| `source_type` | Type of the source |
| `source_created_at` | When the source was ingested |
| `participants` | Participants of the source (if meeting) |

**Why:** The comparative analysis showed that entity descriptions alone lose the original context. When Claude retrieves an entity like "Sales Simulator Tool," it gets a compressed description but loses the surrounding context of how the idea emerged in conversation. Including the `quote` and a source excerpt restores that context without requiring a separate `get_source_content` call.

---

## 4. Implementation Architecture

### Serverless Endpoint Structure

Each new MCP tool maps to a Vercel serverless function. All functions follow the existing self-containment constraint — zero shared local imports, all helpers defined inline, npm imports are fine.

```
api/mcp/
├── get-source-content.ts      → A1
├── get-meeting-brief.ts       → A2
├── get-related-sources.ts     → A3
├── search-sources.ts          → A4
```

Existing tool endpoints are modified in-place for parameter additions (B1, B2, B3) and response improvements (C1, C2).

### Authentication

All endpoints verify the Supabase JWT from the request headers and use it to initialize a scoped Supabase client. RLS handles user isolation — no additional filtering needed beyond what the policies enforce.

### Shared Query Patterns

The cross-source edge traversal query (used by both `get_meeting_brief` and `get_related_sources`) should be implemented as an inline helper within each serverless function (due to the self-containment constraint). The logic is identical — factor it into a well-documented pattern that can be copy-pasted:

```typescript
// Cross-source connection finder
// Given a source_id, finds other sources that share entity connections
async function findRelatedSources(
  supabase: SupabaseClient,
  sourceId: string,
  sourceTypeFilter?: string,
  limit: number = 10
): Promise<RelatedSource[]> {
  // 1. Get all node IDs from this source
  const { data: sourceNodes } = await supabase
    .from('knowledge_nodes')
    .select('id')
    .eq('source_id', sourceId);

  if (!sourceNodes?.length) return [];

  const nodeIds = sourceNodes.map(n => n.id);

  // 2. Find edges connecting to nodes from other sources
  const { data: edges } = await supabase
    .from('knowledge_edges')
    .select(`
      source_node_id,
      target_node_id,
      relation_type
    `)
    .or(
      nodeIds.map(id =>
        `source_node_id.eq.${id},target_node_id.eq.${id}`
      ).join(',')
    );

  // 3. Collect "other side" node IDs
  const otherNodeIds = new Set<string>();
  edges?.forEach(edge => {
    if (nodeIds.includes(edge.source_node_id) && !nodeIds.includes(edge.target_node_id)) {
      otherNodeIds.add(edge.target_node_id);
    }
    if (nodeIds.includes(edge.target_node_id) && !nodeIds.includes(edge.source_node_id)) {
      otherNodeIds.add(edge.source_node_id);
    }
  });

  // 4. Fetch those nodes with their source info
  const { data: otherNodes } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, source_id')
    .in('id', Array.from(otherNodeIds))
    .neq('source_id', sourceId);

  // 5. Group by source_id, count shared entities, join to knowledge_sources
  // ... (grouping and sorting logic)
}
```

---

## 5. Database Dependencies

### Required Before Implementation

**`participants TEXT[]` column on `knowledge_sources`** — being added via a separate migration prompt. This PRD depends on that column existing for:
- `search_sources` participant filter
- `get_source_content` participants in response
- `get_meeting_brief` meeting metadata
- `get_recent_sources` response enrichment (C1)

### No Other Schema Changes

Everything else in this PRD operates on existing columns and indexes:
- `knowledge_sources.content` — already stores full transcripts
- `knowledge_sources.created_at` — already indexed
- `knowledge_sources.source_type` — already exists
- `knowledge_sources.metadata` — already JSONB
- `knowledge_nodes.source_id` — already FK to sources
- `knowledge_nodes.entity_type` — already exists
- `knowledge_nodes.quote` — already exists
- `knowledge_nodes.embedding` — already exists with vector index
- `knowledge_edges.source_node_id` / `target_node_id` — already indexed
- `source_chunks.source_id` — already indexed
- `source_chunks.embedding` — already has vector index

---

## 6. Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| Source not found by title | Return `null` with message: "No source found matching '[query]'. Try `search_sources` with broader terms or check `get_recent_sources` for recent ingestions." |
| Multiple sources match fuzzy title search | Return the most recently created match. Include a note: "Multiple sources matched. Returning most recent. Use `search_sources` to see all matches." |
| Meeting has no extracted entities | Return meeting metadata with empty entity arrays. Include note: "This meeting has been ingested but no entities have been extracted yet. The transcript is available via `get_source_content`." |
| Source content exceeds max length | Truncate at `max_content_length`, set `content_truncated: true`. Include total `content_length` so the caller knows how much was cut. |
| Participant search with no matches | Return empty array. Don't error — an empty result is a valid result. |
| Date range with no results | Return empty array with message suggesting a broader date range. |
| `ask_synapse` with `source_ids` filter returns no chunks | Fall back to global search (unscoped) and note in the response that no chunks were found in the specified sources. |
| Cross-source query on a source with 0 nodes | Return empty `related_sources`. Note: "This source has no extracted entities, so cross-source connections cannot be determined." |
| Entity in `get_entity` has no embedding (so source excerpt lookup fails) | Skip the `source_excerpt` field, return `null` for it. Still return `quote` if it exists. |

---

## 7. Forward-Compatible Decisions

- **Tool naming convention:** All new tools use `snake_case` names consistent with existing tools (`ask_synapse`, `search_entities`, `get_connections`). Future tools should follow the same pattern.
- **Source metadata shape:** The standardized source response shape (C1) should be treated as a contract. Future tools that return source data must include the same fields.
- **`get_meeting_brief` entity grouping:** The entity type → group mapping (Decision → decisions, Action → action_items, etc.) should be easy to extend. If new entity types are added to the ontology, they should be assigned to the appropriate group.
- **Cross-source traversal pattern:** The inline helper for finding related sources is reusable. Future tools (e.g., a hypothetical `get_source_timeline` that shows how a topic evolved across sources) should use the same pattern.
- **`search_sources` as the universal source finder:** This tool is designed to be the go-to for any "find me a source" query. Future parameter additions (e.g., `anchor_id` to find sources linked to a specific anchor, `entity_label` to find sources mentioning a specific entity) should be additive — never break the existing parameter contract.
- **Scoped RAG as a pattern:** The `source_ids` parameter on `ask_synapse` establishes the pattern of scoped retrieval. Future PRDs (e.g., the ChatEntryContext system from PRD-B) should use this parameter to constrain RAG when the chat is entered from a specific source or entity context.

---

## 8. Acceptance Criteria

After this PRD is implemented, a user (via Claude or any MCP client) can:

**New capabilities:**
- [ ] Retrieve the full transcript of any meeting or source by title or ID (`get_source_content`)
- [ ] Get a structured meeting intelligence brief — decisions, actions, insights, related meetings — in a single tool call (`get_meeting_brief`)
- [ ] Find which other sources share connections with a given source (`get_related_sources`)
- [ ] Search sources by keyword, date range, source type, and participant name (`search_sources`)
- [ ] Ask "meetings with Antonio last week" and get precise results combining participant and date filters

**Improved existing capabilities:**
- [ ] Filter `get_recent_sources` by date range ("sources from yesterday", "meetings this week")
- [ ] Scope `ask_synapse` RAG search to specific sources ("summarize only this meeting")
- [ ] Scope `search_entities` to a specific source ("entities from the IQVIA meeting")
- [ ] See consistent metadata (participants, entity count, source_id) across all tool responses
- [ ] Get original source context (quote + excerpt) when looking up an entity via `get_entity`

**The "IQVIA test":**
- [ ] "Find the IQVIA meeting from March 25" → `search_sources(query: "IQVIA", source_type: "Meeting", date_from: "2026-03-25", date_to: "2026-03-25")` returns the correct source
- [ ] "Give me the full transcript" → `get_source_content(source_id: ...)` returns the complete meeting transcript with participants listed
- [ ] "What were the action items and decisions?" → `get_meeting_brief(source_id: ...)` returns structured decisions, actions, insights, and related sources
- [ ] "What other meetings are related?" → `get_related_sources(source_id: ...)` returns the March 20 debrief, March 11 prep, and earlier collab discussion — all in one call
- [ ] "Summarize only this meeting's content" → `ask_synapse(query: "summarize the key points", source_ids: [...])` returns a focused answer scoped to this meeting's chunks

---

## 9. Priority Implementation Order

If this PRD needs to be implemented incrementally, this is the recommended sequence:

| Priority | Item | Rationale |
|---|---|---|
| 1 | `get_source_content` (A1) | Highest impact, simplest implementation. Single SELECT on existing column. Immediately unlocks transcript-based workflows. |
| 2 | `search_sources` (A4) | Unlocks date + participant + keyword search. Prerequisite for efficiently finding sources to pass to other tools. |
| 3 | `get_recent_sources` date filters (B1) | Smallest change, high value. Two WHERE clauses on an existing query. |
| 4 | `get_meeting_brief` (A2) | Compound query, higher effort. But this is the transformative "one call instead of eight" improvement. |
| 5 | `ask_synapse` source scoping (B2) | Requires modifying the RPC or creating a new one. Medium effort, high precision improvement. |
| 6 | `get_related_sources` (A3) | Cross-source traversal. Shares query logic with `get_meeting_brief`, so implement after A2. |
| 7 | `search_entities` source scoping (B3) | Simple WHERE clause addition. Lower priority because `get_meeting_brief` covers most use cases. |
| 8 | Response consistency (C1) | Standardization pass across all tools. Best done after all new tools exist. |
| 9 | `get_entity` enrichment (C2) | Embedding similarity lookup for source excerpt. Lowest priority, nicest polish. |
