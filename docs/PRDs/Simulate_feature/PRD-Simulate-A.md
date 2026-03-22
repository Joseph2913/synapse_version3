# PRD-Simulate-A — Simulate View (Synapse Side)

**Phase:** Phase 5 — Advanced Intelligence  
**Dependencies:** PRD 1 (scaffold + auth), PRD 2 (app shell + nav), PRD 3 (settings + anchors), PRD 7 (ingestion pipeline)  
**Estimated Complexity:** High  
**Companion PRD:** PRD-Simulate-B (MiroFish sidecar — separate repo)

---

## 1. Objective

Add a **Simulate** view to Synapse that allows users to select a scoped subgraph from their knowledge graph, write a natural-language prediction question, and trigger a MiroFish simulation that runs locally on their machine. The simulation generates a structured prediction report which is surfaced in the UI and optionally re-ingested back into the knowledge graph as a new source. The user never interacts with MiroFish directly — from their perspective, Simulate is a native Synapse feature.

---

## 2. What Gets Built

### New Files — Created

| File | Purpose |
|---|---|
| `src/pages/SimulateView.tsx` | Top-level page component, manages simulation state machine |
| `src/components/simulate/ScopeSelector.tsx` | Anchor-based subgraph scope picker |
| `src/components/simulate/PredictionInput.tsx` | Prediction question + what-if variable inputs |
| `src/components/simulate/PersonaPreview.tsx` | Read-only auto-generated agent list |
| `src/components/simulate/SimulationRunner.tsx` | Async progress display during active simulation |
| `src/components/simulate/SimulationReport.tsx` | Structured results renderer |
| `src/components/simulate/SimulationHistoryPanel.tsx` | Right panel — past simulation list |
| `src/components/simulate/SimulationDetailPanel.tsx` | Right panel — selected simulation detail |
| `src/hooks/useSimulate.ts` | Core simulation orchestration hook |
| `src/hooks/useSimulationJobs.ts` | Supabase polling + real-time subscription hook |
| `src/services/simulate.ts` | Supabase queries + sidecar HTTP calls for simulation |
| `src/types/simulate.ts` | All TypeScript types for simulation domain |
| `supabase/migrations/YYYYMMDD_simulation_jobs.sql` | New table migration |

### Existing Files — Modified

| File | Change |
|---|---|
| `src/app/Router.tsx` | Add `/simulate` route |
| `src/components/layout/NavRail.tsx` | Add Simulate nav item |
| `src/services/supabase.ts` | Add simulation query functions |
| `src/types/database.ts` | Add `simulation_jobs` table types |

---

## 3. Database Migration

### New Table: `simulation_jobs`

```sql
CREATE TABLE simulation_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','preparing','running','completed','failed')),
  title                 TEXT NOT NULL,                        -- auto-generated from anchor labels
  scope_anchor_ids      UUID[] NOT NULL DEFAULT '{}',
  scope_time_window_days INTEGER NOT NULL DEFAULT 90,
  scope_node_count      INTEGER,                              -- populated after graph export
  scope_edge_count      INTEGER,
  scope_source_count    INTEGER,
  prediction_question   TEXT NOT NULL,
  what_if_variables     TEXT[] NOT NULL DEFAULT '{}',
  excluded_node_ids     UUID[] NOT NULL DEFAULT '{}',
  seed_graph            JSONB,                                -- serialised subgraph sent to sidecar
  progress              INTEGER NOT NULL DEFAULT 0,           -- 0–100
  progress_message      TEXT,
  result                JSONB,                                -- structured report from MiroFish
  ingested_source_id    UUID REFERENCES knowledge_sources(id), -- if report was re-ingested
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

-- RLS
ALTER TABLE simulation_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own simulation jobs"
  ON simulation_jobs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for polling
CREATE INDEX idx_simulation_jobs_user_status 
  ON simulation_jobs(user_id, status, created_at DESC);
```

---

## 4. TypeScript Types

### `src/types/simulate.ts`

```typescript
export type SimulationStatus = 
  'pending' | 'preparing' | 'running' | 'completed' | 'failed';

export interface SimulationJob {
  id: string;
  userId: string;
  status: SimulationStatus;
  title: string;
  scopeAnchorIds: string[];
  scopeTimeWindowDays: number;
  scopeNodeCount: number | null;
  scopeEdgeCount: number | null;
  scopeSourceCount: number | null;
  predictionQuestion: string;
  whatIfVariables: string[];
  excludedNodeIds: string[];
  seedGraph: SimulationSeedGraph | null;
  progress: number;
  progressMessage: string | null;
  result: SimulationReport | null;
  ingestedSourceId: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SimulationSeedGraph {
  nodes: SimulationNode[];
  edges: SimulationEdge[];
  sourceChunks: SimulationChunk[];
  metadata: {
    exportedAt: string;
    anchorIds: string[];
    timeWindowDays: number;
  };
}

export interface SimulationNode {
  id: string;
  label: string;
  entityType: string;
  description: string;
  isAnchor: boolean;
  confidence: number;
  centrality: number;       // computed: number of edges this node has
  sourceId: string | null;
  tags: string[];
}

export interface SimulationEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
  evidence: string;
  weight: number;
}

export interface SimulationChunk {
  id: string;
  sourceId: string;
  content: string;
  chunkIndex: number;
}

export interface SimulationReport {
  headline: string;
  summary: string;
  forecasts: SimulationForecast[];
  agentMoves: SimulationAgentMove[];
  surprises: string[];
  confidenceLevel: 'low' | 'medium' | 'high';
  confidenceRationale: string;
  simulationRounds: number;
  agentCount: number;
  generatedAt: string;
}

export interface SimulationForecast {
  direction: string;
  rationale: string;
  timeframe: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface SimulationAgentMove {
  agentLabel: string;
  entityType: string;
  likelyAction: string;
  rationale: string;
  influence: 'low' | 'medium' | 'high';
}

// Builder state — local to SimulateView
export interface SimulationBuilderState {
  selectedAnchorIds: string[];
  timeWindowDays: number;
  predictionQuestion: string;
  whatIfVariables: string[];
  excludedNodeIds: string[];
  currentWhatIfInput: string;
}
```

---

## 5. Service Layer

### `src/services/simulate.ts`

```typescript
import { supabase } from './supabase';
import type { 
  SimulationJob, SimulationSeedGraph, SimulationBuilderState 
} from '../types/simulate';

const SIDECAR_URL = import.meta.env.VITE_SIMULATE_SIDECAR_URL ?? 'http://localhost:8000';

// ─── SUPABASE QUERIES ───────────────────────────────────────────────

export async function fetchSimulationJobs(): Promise<SimulationJob[]> {
  const { data, error } = await supabase
    .from('simulation_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map(mapJobRow);
}

export async function fetchSimulationJob(id: string): Promise<SimulationJob | null> {
  const { data, error } = await supabase
    .from('simulation_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapJobRow(data) : null;
}

export async function createSimulationJob(
  state: SimulationBuilderState,
  title: string
): Promise<SimulationJob> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('simulation_jobs')
    .insert({
      user_id: user.id,
      status: 'pending',
      title,
      scope_anchor_ids: state.selectedAnchorIds,
      scope_time_window_days: state.timeWindowDays,
      prediction_question: state.predictionQuestion,
      what_if_variables: state.whatIfVariables,
      excluded_node_ids: state.excludedNodeIds,
    })
    .select()
    .single();
  if (error) throw error;
  return mapJobRow(data);
}

export async function updateSimulationJobStatus(
  id: string,
  update: Partial<Pick<SimulationJob, 
    'status' | 'progress' | 'progressMessage' | 'result' | 
    'errorMessage' | 'completedAt' | 'seedGraph' |
    'scopeNodeCount' | 'scopeEdgeCount' | 'scopeSourceCount'
  >>
): Promise<void> {
  const snakeUpdate = {
    ...(update.status !== undefined && { status: update.status }),
    ...(update.progress !== undefined && { progress: update.progress }),
    ...(update.progressMessage !== undefined && { progress_message: update.progressMessage }),
    ...(update.result !== undefined && { result: update.result }),
    ...(update.errorMessage !== undefined && { error_message: update.errorMessage }),
    ...(update.completedAt !== undefined && { completed_at: update.completedAt }),
    ...(update.seedGraph !== undefined && { seed_graph: update.seedGraph }),
    ...(update.scopeNodeCount !== undefined && { scope_node_count: update.scopeNodeCount }),
    ...(update.scopeEdgeCount !== undefined && { scope_edge_count: update.scopeEdgeCount }),
    ...(update.scopeSourceCount !== undefined && { scope_source_count: update.scopeSourceCount }),
  };
  const { error } = await supabase
    .from('simulation_jobs')
    .update(snakeUpdate)
    .eq('id', id);
  if (error) throw error;
}

// ─── GRAPH EXPORT ───────────────────────────────────────────────────

export async function buildSeedGraph(
  anchorIds: string[],
  timeWindowDays: number,
  excludedNodeIds: string[]
): Promise<SimulationSeedGraph> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - timeWindowDays);
  const cutoffISO = cutoff.toISOString();

  // Fetch nodes: anchor nodes + all nodes from sources containing anchors
  // Strategy: get all nodes created after cutoff, then filter by relevance to selected anchors
  const { data: allNodes, error: nodesError } = await supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, is_anchor, confidence, source_id, tags, created_at')
    .gte('created_at', cutoffISO)
    .not('id', 'in', `(${excludedNodeIds.map(id => `'${id}'`).join(',') || "''"})` )
    .order('created_at', { ascending: false });
  if (nodesError) throw nodesError;

  const nodes = allNodes ?? [];
  const nodeIds = nodes.map(n => n.id);

  // Fetch edges between these nodes
  const { data: allEdges, error: edgesError } = await supabase
    .from('knowledge_edges')
    .select('id, source_node_id, target_node_id, relation_type, evidence, weight')
    .in('source_node_id', nodeIds)
    .in('target_node_id', nodeIds);
  if (edgesError) throw edgesError;

  // Compute centrality (edge count per node)
  const edgeCounts: Record<string, number> = {};
  (allEdges ?? []).forEach(e => {
    edgeCounts[e.source_node_id] = (edgeCounts[e.source_node_id] ?? 0) + 1;
    edgeCounts[e.target_node_id] = (edgeCounts[e.target_node_id] ?? 0) + 1;
  });

  // Fetch source chunks for context
  const sourceIds = [...new Set(nodes.map(n => n.source_id).filter(Boolean))];
  const { data: chunks, error: chunksError } = await supabase
    .from('source_chunks')
    .select('id, source_id, content, chunk_index')
    .in('source_id', sourceIds as string[])
    .limit(200); // cap to avoid oversized payloads
  if (chunksError) throw chunksError;

  return {
    nodes: nodes.map(n => ({
      id: n.id,
      label: n.label,
      entityType: n.entity_type,
      description: n.description ?? '',
      isAnchor: n.is_anchor ?? false,
      confidence: n.confidence ?? 0.8,
      centrality: edgeCounts[n.id] ?? 0,
      sourceId: n.source_id ?? null,
      tags: n.tags ?? [],
    })),
    edges: (allEdges ?? []).map(e => ({
      id: e.id,
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      relationType: e.relation_type,
      evidence: e.evidence ?? '',
      weight: e.weight ?? 1.0,
    })),
    sourceChunks: (chunks ?? []).map(c => ({
      id: c.id,
      sourceId: c.source_id,
      content: c.content,
      chunkIndex: c.chunk_index,
    })),
    metadata: {
      exportedAt: new Date().toISOString(),
      anchorIds,
      timeWindowDays,
    },
  };
}

// ─── SIDECAR COMMUNICATION ───────────────────────────────────────────

export async function triggerSidecarSimulation(
  jobId: string,
  seedGraph: SimulationSeedGraph,
  predictionQuestion: string,
  whatIfVariables: string[]
): Promise<void> {
  const response = await fetch(`${SIDECAR_URL}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      seed_graph: seedGraph,
      prediction_question: predictionQuestion,
      what_if_variables: whatIfVariables,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sidecar error: ${response.status} — ${text}`);
  }
}

export async function checkSidecarHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── PREVIEW: PERSONAS DERIVED FROM GRAPH ────────────────────────────

export function derivePersonasFromGraph(seedGraph: SimulationSeedGraph): SimulationNode[] {
  // Person + Organization nodes only, sorted by centrality desc
  return seedGraph.nodes
    .filter(n => ['Person', 'Organization', 'Team'].includes(n.entityType))
    .sort((a, b) => {
      // Anchors first, then by centrality
      if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1;
      return b.centrality - a.centrality;
    });
}

// ─── MAPPER ─────────────────────────────────────────────────────────

function mapJobRow(row: Record<string, unknown>): SimulationJob {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    status: row.status as SimulationStatus,
    title: row.title as string,
    scopeAnchorIds: (row.scope_anchor_ids as string[]) ?? [],
    scopeTimeWindowDays: row.scope_time_window_days as number,
    scopeNodeCount: row.scope_node_count as number | null,
    scopeEdgeCount: row.scope_edge_count as number | null,
    scopeSourceCount: row.scope_source_count as number | null,
    predictionQuestion: row.prediction_question as string,
    whatIfVariables: (row.what_if_variables as string[]) ?? [],
    excludedNodeIds: (row.excluded_node_ids as string[]) ?? [],
    seedGraph: row.seed_graph as SimulationSeedGraph | null,
    progress: row.progress as number,
    progressMessage: row.progress_message as string | null,
    result: row.result as SimulationReport | null,
    ingestedSourceId: row.ingested_source_id as string | null,
    errorMessage: row.error_message as string | null,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | null,
  };
}
```

### Environment Variable Addition

Add to `.env.local` and Vercel dashboard:
```bash
VITE_SIMULATE_SIDECAR_URL=http://localhost:8000
# For production (Railway/Fly.io): https://your-sidecar-service.railway.app
```

---

## 6. Hooks

### `src/hooks/useSimulate.ts`

Manages the full simulation lifecycle from the builder through to results.

```typescript
import { useState, useCallback } from 'react';
import type { SimulationBuilderState, SimulationJob } from '../types/simulate';
import {
  createSimulationJob,
  buildSeedGraph,
  triggerSidecarSimulation,
  updateSimulationJobStatus,
  checkSidecarHealth,
} from '../services/simulate';

type SimulatePhase = 'builder' | 'confirming' | 'running' | 'completed' | 'failed';

interface UseSimulateReturn {
  phase: SimulatePhase;
  activeJob: SimulationJob | null;
  sidecarOnline: boolean;
  isCheckingSidecar: boolean;
  error: string | null;
  checkSidecar: () => Promise<void>;
  startSimulation: (state: SimulationBuilderState) => Promise<void>;
  resetBuilder: () => void;
}

export function useSimulate(): UseSimulateReturn {
  const [phase, setPhase] = useState<SimulatePhase>('builder');
  const [activeJob, setActiveJob] = useState<SimulationJob | null>(null);
  const [sidecarOnline, setSidecarOnline] = useState(false);
  const [isCheckingSidecar, setIsCheckingSidecar] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkSidecar = useCallback(async () => {
    setIsCheckingSidecar(true);
    const online = await checkSidecarHealth();
    setSidecarOnline(online);
    setIsCheckingSidecar(false);
  }, []);

  const startSimulation = useCallback(async (state: SimulationBuilderState) => {
    setError(null);
    setPhase('confirming');

    try {
      // 1. Build seed graph from Supabase
      const seedGraph = await buildSeedGraph(
        state.selectedAnchorIds,
        state.timeWindowDays,
        state.excludedNodeIds
      );

      // 2. Auto-generate title from anchor labels (fetched via GraphContext or passed in)
      const title = `Simulation — ${new Date().toLocaleDateString('en-GB', { 
        day: 'numeric', month: 'short', year: 'numeric' 
      })}`;

      // 3. Create job record in Supabase
      const job = await createSimulationJob(state, title);

      // 4. Update with graph stats + seed
      await updateSimulationJobStatus(job.id, {
        status: 'preparing',
        progress: 10,
        progressMessage: 'Preparing knowledge graph export…',
        seedGraph,
        scopeNodeCount: seedGraph.nodes.length,
        scopeEdgeCount: seedGraph.edges.length,
        scopeSourceCount: [...new Set(seedGraph.nodes.map(n => n.sourceId).filter(Boolean))].length,
      });

      setActiveJob({ ...job, status: 'preparing', progress: 10 });
      setPhase('running');

      // 5. Fire-and-forget to sidecar (sidecar writes progress back to Supabase)
      await triggerSidecarSimulation(
        job.id,
        seedGraph,
        state.predictionQuestion,
        state.whatIfVariables
      );

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(message);
      setPhase('failed');
    }
  }, []);

  const resetBuilder = useCallback(() => {
    setPhase('builder');
    setActiveJob(null);
    setError(null);
  }, []);

  return { phase, activeJob, sidecarOnline, isCheckingSidecar, error, checkSidecar, startSimulation, resetBuilder };
}
```

### `src/hooks/useSimulationJobs.ts`

Polls and subscribes to simulation job status updates.

```typescript
import { useState, useEffect, useRef } from 'react';
import { supabase } from '../services/supabase';
import { fetchSimulationJobs, fetchSimulationJob } from '../services/simulate';
import type { SimulationJob } from '../types/simulate';

export function useSimulationJobs() {
  const [jobs, setJobs] = useState<SimulationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const data = await fetchSimulationJobs();
        if (mounted) { setJobs(data); setLoading(false); }
      } catch {
        if (mounted) setLoading(false);
      }
    }
    load();

    // Real-time subscription for status/progress updates
    channelRef.current = supabase
      .channel('simulation_jobs_changes')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'simulation_jobs',
      }, async (payload) => {
        const updated = await fetchSimulationJob(payload.new.id as string);
        if (updated && mounted) {
          setJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
        }
      })
      .subscribe();

    return () => {
      mounted = false;
      channelRef.current?.unsubscribe();
    };
  }, []);

  return { jobs, loading };
}
```

---

## 7. Page Structure & Components

### `src/pages/SimulateView.tsx`

Top-level state machine. Renders one of four states based on `phase`.

```typescript
'builder'   → <ScopeSelector /> + <PredictionInput /> + <PersonaPreview /> 
'running'   → <SimulationRunner /> (job polling)
'completed' → <SimulationReport />
'failed'    → Error state with retry
```

Right panel always shows `<SimulationHistoryPanel />` unless a past job is selected, in which case shows `<SimulationDetailPanel />`.

---

### `src/components/simulate/ScopeSelector.tsx`

**What it renders:**
- Section label: "KNOWLEDGE SCOPE" (uppercase, 10px, Cabinet Grotesk 700, `--text-secondary`)
- Anchor cards in a 2-column grid. Each card:
  - Entity type dot (6px, entity color)
  - Node label (14px DM Sans 500, `--text-primary`)
  - Description (12px DM Sans, `--text-secondary`, 1 line truncated)
  - Edge count badge (e.g. "14 connections")
  - Selected state: `--accent-50` background, `--accent-500` border (1px), `--accent-500` checkmark icon top-right
  - Unselected state: white card, `rgba(0,0,0,0.10)` border
  - Hover: border darkens to `rgba(0,0,0,0.16)`, 1px translateY(-1px)
  - Transition: 0.15s ease
- If no anchors exist: empty state — "No anchors in your graph yet. Promote key nodes to anchors in Explore or Settings." with link.

**Time window selector** below the grid:
- Toggle group: "30 days / 90 days / 6 months / All time"
- Inset container (`--bg-inset`), white active pill with shadow
- Active selection shown with a scope preview pill: "~47 entities · ~89 relationships · 23 sources"
- Scope stats loaded asynchronously, shown with a loading shimmer on first render

**Props:**
```typescript
interface ScopeSelectorProps {
  selectedAnchorIds: string[];
  timeWindowDays: number;
  onAnchorToggle: (id: string) => void;
  onTimeWindowChange: (days: number) => void;
}
```

---

### `src/components/simulate/PredictionInput.tsx`

**What it renders:**
- Section label: "PREDICTION QUESTION"
- Large textarea (min-height 80px, max-height 160px, auto-resize):
  - Background: `--bg-inset` (#f0f0f0)
  - Border: `rgba(0,0,0,0.10)`, 1px
  - Focus ring: `--accent-500` at 30% opacity, 2px offset
  - Font: 15px DM Sans, `--text-primary`
  - Placeholder: "What do you want to predict or explore?" in `--text-placeholder`
  - Placeholder examples shown below as ghost pills: "Where is this field heading in 6 months?" / "Which players are likely to make a major move?" — clicking one populates the textarea
- Section label: "WHAT-IF VARIABLES" (optional)
  - Helper text: "Inject assumptions into the simulation" (12px, `--text-secondary`)
  - Input row with `+` button to add variables. Each variable added becomes a dismissible pill below.
  - Pills: `--bg-inset` bg, `rgba(0,0,0,0.10)` border, × icon on hover
  - Max 5 variables

**Props:**
```typescript
interface PredictionInputProps {
  predictionQuestion: string;
  whatIfVariables: string[];
  currentWhatIfInput: string;
  onQuestionChange: (q: string) => void;
  onWhatIfAdd: (variable: string) => void;
  onWhatIfRemove: (index: number) => void;
  onWhatIfInputChange: (value: string) => void;
}
```

---

### `src/components/simulate/PersonaPreview.tsx`

**What it renders:**
- Section label: "SIMULATION AGENTS" with agent count badge
- Helper text: "Auto-generated from your knowledge graph. Anchors become high-influence agents." (12px, `--text-secondary`)
- Scrollable list (max-height 280px, custom scrollbar) of persona cards:
  - Each card: entity type badge (dot + label) + node label (14px, 500) + description excerpt (12px, `--text-secondary`, 2 lines) + influence indicator (low/medium/high dot — green/amber/accent) + "Exclude" ghost button (appears on hover only)
  - Excluded entities shown with strikethrough + grey opacity
  - Anchor-status agents: subtle `--accent-50` left border (3px)
- If fewer than 3 personas derivable: warning banner — "Limited agents available. Simulations work best with 5+ Person or Organization nodes in scope."
- "Preview only — agents are derived automatically from your graph" label at bottom, 11px, `--text-secondary`

**Props:**
```typescript
interface PersonaPreviewProps {
  seedGraph: SimulationSeedGraph | null;
  excludedNodeIds: string[];
  onExcludeToggle: (nodeId: string) => void;
  loading: boolean;
}
```

Seed graph is computed lazily when the user has ≥1 anchor selected and a time window set.

---

### `src/components/simulate/SimulationRunner.tsx`

**What it renders:**

Async progress view while simulation is active. Full center-stage takeover (no other content visible).

- Large status icon (animated — pulsing circle, `--accent-500`)
- Status label (18px Cabinet Grotesk, `--text-primary`): maps status → human label:
  - `preparing` → "Preparing your knowledge graph…"
  - `running` → "Running simulation…"
- Progress bar: full-width, 4px height, `--bg-inset` track, `--accent-500` fill, animated smooth transition
- Progress percentage (12px, `--text-secondary`, right-aligned)
- Progress message (13px DM Sans, `--text-secondary`, italic) — e.g. "Generating agent personas (14 agents)…"
- Scope summary (below progress): "47 entities · 89 relationships · 14 agents · 90-day window"
- Estimated time note: "Simulations typically take 5–15 minutes. You can leave this page — we'll notify you when it's ready."
- "Running in background" pill with pulsing dot when user navigates away (shown in nav rail next to Simulate icon)

**Props:**
```typescript
interface SimulationRunnerProps {
  job: SimulationJob;
}
```

Uses `useSimulationJobs` hook internally for real-time updates.

---

### `src/components/simulate/SimulationReport.tsx`

**What it renders:**

Structured report display after `status === 'completed'`.

- **Header card** (white, full-width):
  - "SIMULATION COMPLETE" section label
  - Headline prediction (20px Cabinet Grotesk, `--text-primary`, tight line-height)
  - Metadata row: date · agent count · simulation rounds · confidence badge
  - Confidence badge: color-coded — low (amber), medium (blue), high (green)

- **Forecasts section** — "KEY FORECASTS" label + list of forecast cards:
  - Each card: direction text (15px, 500) + rationale (13px, `--text-secondary`) + timeframe pill + confidence dot
  - Left border (3px) in confidence color

- **Agent Moves section** — "LIKELY MOVES" label + compact list:
  - Entity type badge + agent name + "is likely to…" + action text + influence indicator
  - High-influence moves marked with accent dot

- **Surprises section** — "UNEXPECTED SIGNALS" label:
  - Yellow/amber left border (3px)
  - Each item: 14px DM Sans, body color

- **Confidence Rationale** — collapsible, "Why this confidence level?" — shows rationale text

- **Action bar** (bottom of report, sticky on scroll):
  - "Re-run with same scope" ghost button
  - "Ingest report into graph" secondary button → triggers re-ingestion pipeline
  - "Share" ghost button (copies report text to clipboard)

**Props:**
```typescript
interface SimulationReportProps {
  job: SimulationJob;
  onRerun: () => void;
  onIngest: (jobId: string) => Promise<void>;
}
```

---

### `src/components/simulate/SimulationHistoryPanel.tsx`

Right panel content — list of past simulations.

- Section label: "SIMULATION HISTORY"
- List of simulation summary rows, most recent first:
  - Title (13px, 500) + date (12px, `--text-secondary`)
  - Status pill: completed (green) / failed (red) / running (pulsing amber)
  - Clicking a row opens `SimulationDetailPanel`
- Empty state: "No simulations run yet. Build your first simulation above."

---

### `src/components/simulate/SimulationDetailPanel.tsx`

Right panel content — detail view for a selected past simulation.

- Back button ("← History")
- Job title + date
- Scope summary: anchor tags + time window + entity/edge counts
- Prediction question (blockquote style — left border `--accent-200`, italic)
- What-if variables list (if any)
- Status + completion time
- "View Full Report" button → sets active job in SimulateView and scrolls to report
- "Re-run" ghost button

---

## 8. Navigation Integration

### Nav Rail Addition

Add Simulate between Ask and Automate in the nav rail:

```typescript
// In NavRail.tsx — add to nav items array
{
  path: '/simulate',
  icon: FlaskConical,   // Lucide icon
  label: 'Simulate',
}
```

If a simulation is actively running (`status === 'running'`), show a pulsing amber dot on the Simulate nav icon — regardless of which page the user is on. This requires reading from `useSimulationJobs` at the layout shell level.

### Router Addition

```typescript
// src/app/Router.tsx
{ path: '/simulate', element: <SimulateView /> }
```

---

## 9. Re-ingestion Pipeline

When the user clicks "Ingest report into graph":

1. Extract `result.headline + result.summary + result.forecasts + result.surprises` as a formatted text document
2. Call the existing `saveKnowledgeSource()` with:
   - `title`: `"Simulation: ${job.predictionQuestion.slice(0, 60)}…"`
   - `content`: formatted report text
   - `source_type`: `'simulation'` (new type — add to source_type enum)
   - `metadata`: `{ jobId: job.id, simulationDate: job.completedAt, agentCount: job.result.agentCount }`
3. Pass to the existing extraction pipeline (same as any other ingest)
4. Update `simulation_jobs.ingested_source_id` with the new source ID
5. Show a success toast: "Report added to your knowledge graph"

---

## 10. Sidecar Health & Error States

### Health Check on Page Load

When `SimulateView` mounts, call `checkSidecarHealth()` once. Results:

- **Online**: Green dot + "Simulation engine ready" in the builder header
- **Offline**: Amber warning banner:
  > "The simulation engine isn't running. Start it on your machine: `python run.py` in your MiroFish directory."
  > [Check Again] button

The Run button is **disabled** while sidecar is offline.

### Error States

| Error | User-facing message |
|---|---|
| Sidecar offline | "Simulation engine not reachable. Make sure MiroFish is running locally." |
| No anchors selected | "Select at least one anchor to define your simulation scope." |
| Empty prediction question | "Describe what you want to predict." |
| Too few personas (<3) | Warning (non-blocking) — "Limited agents available. Results may be less accurate." |
| Graph export fails | "Couldn't load your knowledge graph. Check your connection and try again." |
| Sidecar returns error | Show raw error message from sidecar + "Check the MiroFish terminal for details." |
| Simulation times out (>30 min) | Auto-mark as failed. "Simulation took too long. Try a smaller scope or shorter time window." |

---

## 11. Interaction & State

### State Managed Locally (SimulateView)

```typescript
const [builderState, setBuilderState] = useState<SimulationBuilderState>({
  selectedAnchorIds: [],
  timeWindowDays: 90,
  predictionQuestion: '',
  whatIfVariables: [],
  excludedNodeIds: [],
  currentWhatIfInput: '',
});
const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null);
const [previewSeedGraph, setPreviewSeedGraph] = useState<SimulationSeedGraph | null>(null);
```

### State That Persists Across Navigation

- `simulation_jobs` table (Supabase) — always persisted
- The real-time subscription in `useSimulationJobs` runs at layout shell level so the nav rail badge stays live

### What Resets on Navigation Away

- `builderState` — resets to defaults (user must rebuild the query)
- `previewSeedGraph` — cleared

---

## 12. Forward-Compatible Decisions

- **`VITE_SIMULATE_SIDECAR_URL`** is an env variable from day one. Swapping from `localhost:8000` to a Railway URL requires zero code changes — just an env update. (Enables PRD-Simulate-B hosted deployment.)
- **`source_type: 'simulation'`** is added to the source type enum so simulation-ingested reports can be filtered separately in Explore and Home. (Enables future "Simulation Sources" filter.)
- **`simulation_jobs` table** stores the full `seed_graph` JSONB. This enables future diff/replay features — re-running the exact same graph against a different question without rebuilding the export.
- **`SimulationReport` type** is structured (typed forecasts, agent moves, surprises) not a flat markdown string. This enables future graph overlays — e.g. highlighting which existing nodes correspond to high-confidence forecasts.
- **`excluded_node_ids`** stored on the job record enables future "Why wasn't X included?" explainability.

---

## 13. Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| User has no anchor nodes | ScopeSelector shows empty state with link to Anchors in Settings |
| User has anchors but no nodes in time window | Scope preview shows "0 entities" — Run button disabled with tooltip |
| MiroFish sidecar goes offline mid-simulation | Supabase polling detects stalled progress (no update in 5 min) → auto-fail with message |
| Sidecar writes a failed status to Supabase | Real-time subscription picks it up → UI transitions to failed state |
| User navigates away during simulation | Runner stays invisible but polling continues; nav badge shows running state |
| User re-opens Simulate during active run | Page detects active job → jumps straight to Runner view |
| Report re-ingestion fails | Toast error — does not mark simulation as failed; simulation result still accessible |
| Very large graph (500+ nodes) | Source chunks capped at 200 in `buildSeedGraph`; nodes/edges uncapped but sidecar must handle |
| Network offline during export | Error caught in `startSimulation` → failed state with retry |

---

## 14. Acceptance Criteria

- After this PRD, a user can navigate to `/simulate` via the nav rail
- The nav rail shows a Simulate item between Ask and Automate with the `FlaskConical` icon
- The ScopeSelector surfaces all anchor nodes as selectable cards
- Selecting anchors and a time window shows a live scope preview (entity/edge/source count)
- A prediction question and optional what-if variables can be entered
- The PersonaPreview shows auto-derived agents from Person/Organization nodes in scope; individual agents can be excluded
- The Run button is disabled if sidecar is offline, no anchors are selected, or question is empty
- Clicking Run creates a `simulation_jobs` row in Supabase, exports the subgraph, and fires the sidecar trigger
- The SimulationRunner shows live progress updates sourced from Supabase real-time subscription
- A pulsing amber nav badge appears on the Simulate icon while a simulation is running
- On completion, the structured report renders with headline, forecasts, agent moves, and surprises
- The user can ingest the report back into the knowledge graph via the action bar button
- All past simulations appear in the right panel history list
- The sidecar health check runs on page load and shows an actionable warning if offline
- All components conform to the Synapse design system — Cabinet Grotesk headings, DM Sans body, `--accent-500` blood orange, token-based colors, no inline styles
- TypeScript strict mode — no `any` types
