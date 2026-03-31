# Performance Patterns — Synapse V2

This document records architectural decisions around data fetching performance, caching, and computation placement. Consult this before writing any data-fetching logic.

---

## 1. Server-Side Computation via Supabase RPC

### The Problem (Explore View — March 2026)

The Explore anchor/cluster landscape view needed summary data for each anchor: entity count, type distribution, cross-cluster edges, inherited entities. The original implementation downloaded **all** nodes and **all** edges to the browser, then computed summaries client-side.

At scale (5,000+ nodes, 6,000+ edges, 187 anchors), this caused:
- **4–6 sequential Supabase round-trips** (paginated in batches of 1000)
- **O(anchors² × edges) computation** in JavaScript for cross-cluster edges
- **Multi-second load times** on every page visit
- Data volume transferred: ~11,000+ rows, when only ~187 summary objects were needed

### The Solution

Move all aggregation logic into a **Postgres function** called via `supabase.rpc('get_cluster_summaries', { p_user_id })`. The database computes cluster membership, type distributions, cross-cluster edges, and inherited entity counts — then returns only the final summaries.

**Result:** One network request, ~187 small JSON objects, sub-second response.

### The Rule

> **If a view needs to download >1000 rows just to reduce/group/count them in JavaScript, that computation belongs in a Postgres RPC function.**

### When to Use RPC vs Client-Side

| Scenario | Where to Compute |
|---|---|
| Aggregate stats across large tables (counts, distributions, cross-references) | **RPC function** |
| Filtering/sorting a list the user is browsing interactively | Client-side (with `useMemo`) — data is already displayed, not just aggregated |
| Search with ranking/scoring | RPC or Supabase full-text search |
| Paginated list with simple filters | Supabase `.select()` with `.range()` — no RPC needed |
| Graph layout / force simulation | Client-side — this is rendering logic, not data logic |
| Entity extraction / AI processing | Server-side (Vercel Functions or Gemini API) |

### RPC Function Conventions

- **Naming:** `get_` prefix for read functions (e.g. `get_cluster_summaries`, `get_source_graph_data`)
- **Parameters:** Always accept `p_user_id UUID` as first parameter. This ensures RLS-compatible filtering even without `SECURITY DEFINER`.
- **Return type:** `SETOF json` for flexible structured results, or define a composite type for strongly-typed returns.
- **Security:** Use `SECURITY INVOKER` (default) unless the function needs to access data the calling user's RLS policies wouldn't allow. Prefer `INVOKER` for safety.
- **Location:** SQL migration files in the Supabase project. Document the function name and its purpose in this file when adding new RPCs.

### Current RPC Functions

| Function | Purpose | Called From |
|---|---|---|
| `get_cluster_summaries(p_user_id)` | Computes anchor cluster summaries for Explore landscape view — entity counts, type distributions, cross-cluster edges, inherited entities | `src/services/exploreQueries.ts` → `fetchClusterData()` |
| `get_anchor_graph(p_user_id)` | Computes anchor-level graph for Graph Tab — entity/source counts per anchor, inter-anchor edges (bridge entities + shared sources), activity status | `src/services/graphQueries.ts` → `fetchAnchorLevelData()` |
| `get_all_sources_graph(p_user_id)` | Computes source-level graph — entity counts and type distributions per source, top 80 source-to-source edges via shared entity labels | `src/services/graphQueries.ts` → `fetchAllSourcesLevelData()` |
| `get_anchor_candidates(p_user_id)` | Fetches all anchor candidates with pre-computed connection counts, anchor connections, source diversity, and live signal inputs — replaces 15-25 separate queries | `src/services/anchorCandidates.ts` → `fetchAllCandidatesViaRpc()` |
| `get_explore_source_graph(p_user_id)` | Computes Explore Sources tab data — source nodes with entity counts/tags, source-to-source edges via cross-source entity connections. No anchors. | `src/services/exploreQueries.ts` → `fetchSourceGraph()` |
| `get_home_dashboard(p_user_id)` | Returns all Home dashboard data in one call — stats (totals + 7d deltas), recent sources with entity counts, recent anchors with connection counts, recent skills, cross-connections, pipeline status, knowledge snapshot. Replaces 12-15 separate queries | `src/app/providers/HomeDashboardProvider.tsx` via `useHomeDashboard()` |
| `get_activity_feed(p_user_id, p_limit, p_offset)` | Returns paginated activity feed with pre-assembled FeedItems — source metadata, entities, within-source connections, cross-source connections with resolved node/source titles. Replaces 6-10 sequential batched queries | `src/services/feedQueries.ts` → `fetchActivityFeed()` |

> **Update this table when adding new RPC functions.**

---

## 2. Data Caching & View Persistence

### The Problem

React Router unmounts view components on navigation. Any data stored in local `useState` is destroyed when the user navigates away and recreated (re-fetched) when they return. For expensive views like Explore, this means a multi-second reload every time the user switches tabs.

### The Solution: Provider-Level Cache with Stale-While-Revalidate

Data that is expensive to fetch and unlikely to change within a session is cached in a **React context provider** that sits above the router. This means:

1. **First visit:** Data is fetched normally. Loading spinner shown.
2. **Subsequent visits (within session):** Cached data is shown instantly. A background refresh happens only if the cache is stale (older than `staleTime`).
3. **Explicit invalidation:** Cache is cleared and refetched when the underlying data actually changes (e.g. anchor confirmed, new ingestion).

### Cache Invalidation Triggers

| Event | Action |
|---|---|
| `synapse:anchor-confirmed` | Invalidate Explore cluster cache |
| `synapse:anchor-suggestions-changed` | Invalidate suggested candidates only |
| New ingestion completes | Invalidate Explore + Home caches |
| User clicks refresh button | Force refetch, replace cache |
| `staleTime` exceeded on re-visit | Background refetch, show stale data immediately |

### The Rule

> **Any view that fetches data on mount and takes >500ms to load should use a provider-level cache, not local `useState` that is destroyed on unmount.**

### Views That Should Use Provider-Level Caching

| View | Data | Cache Provider |
|---|---|---|
| Explore (anchors) | Cluster summaries, graph stats, unclustered nodes | `ExploreDataProvider` |
| Explore (sources) | Source graph data | `ExploreDataProvider` |
| Home | Dashboard stats, recent activity | Consider `HomeDashboardProvider` if load times become an issue |

---

## 3. Modification Guide

### "I need to change how entities are assigned to anchor clusters"

→ Update the **Postgres RPC function** `get_cluster_summaries` in Supabase. The TypeScript in `exploreQueries.ts` only calls `supabase.rpc()` and maps results — it does not contain cluster assignment logic.

### "I need to add a new field to cluster summaries"

→ Add the computation to the Postgres function's return JSON. Then update the `ClusterData` TypeScript type in `src/types/explore.ts` and the mapping in `exploreQueries.ts`.

### "I need to add a new aggregated view (similar to Explore clusters)"

→ Follow the RPC pattern:
1. Write a Postgres function that computes the aggregation server-side
2. Call it via `supabase.rpc()` in a service file
3. Add it to the RPC Functions table above
4. If the view is frequently visited, add a provider-level cache

### "I need to change cache invalidation timing"

→ Adjust `staleTime` in the relevant provider (e.g. `ExploreDataProvider`). For event-based invalidation, add/modify event listeners in the provider.
