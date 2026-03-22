# PRD-Simulate-D — Native Persona Generation

**Phase:** Simulate overhaul  
**Dependencies:** PRD-Simulate-C (SimulationConfig type, config persisted to simulation_jobs)  
**Reference documents:** `SIMULATE-FEATURE.md` (current sidecar implementation) · `SIMULATE-PRINCIPLES.md` (governing principles — Layer 3: Agent Creation)  
**Complexity:** High

---

## Objective

Move persona generation out of the Python sidecar and into Synapse as a native Vercel function. Introduce a human checkpoint between agent creation and simulation execution — the user reviews and approves all generated agent profiles before the simulation runs. This is the foundational change that makes the simulation traceable, diverse, and mode-aware, as required by all three governing principles in `SIMULATE-PRINCIPLES.md`.

---

## What Gets Built

### Files Created
- `api/simulate/generate-personas.ts` — Vercel serverless function (self-contained, zero local imports)
- `src/components/simulate/SimulationRunner.tsx` — replaces or heavily modifies existing runner component
- `src/components/simulate/AgentCard.tsx` — individual agent profile card
- `src/components/simulate/AgentReview.tsx` — agent list + diversity summary + confirm/back actions
- `src/components/simulate/PipelineStages.tsx` — horizontal stage indicator component

### Files Modified
- `src/services/simulate.ts` — new `generatePersonas()` function, updated sidecar POST payload
- `src/hooks/useSimulate.ts` — new stage state machine, persona state
- `synapse-simulate-sidecar/persona_gen.py` — stubbed out (receives pre-built personas, no longer generates them)
- `synapse-simulate-sidecar/main.py` — Pydantic model updated to accept `personas` array in POST body

---

## Data Types

Add to `simulate.ts`:

```typescript
type GroundingQuality = 'strong' | 'moderate' | 'weak' | 'inferred';
type EpistemicStyle = 'empirical' | 'ideological' | 'opportunistic' | 'contrarian' | 'cautious' | 'structural';
type InfluenceTier = 'high' | 'medium' | 'low';
type StanceCategory = 'pro' | 'anti' | 'conditional' | 'uncertain' | 'orthogonal';

interface SimulationPersona {
  agent_id: string;
  label: string;
  entity_type: string;
  influence_tier: InfluenceTier;
  grounding_quality: GroundingQuality;
  grounding_chunk_ids: string[];
  source_count: number;
  documented_position: string;
  question_specific_stance: string;
  stance_category: StanceCategory;
  incentive_structure: string;
  epistemic_style: EpistemicStyle;
  update_conditions: string;
  blind_spots: string;
  inter_agent_relationships: string[];
  behavioural_prompt: string;
  is_synthetic: boolean;
  is_excluded: boolean;
}

interface PersonaSetDiversity {
  score: number;
  distribution: Record<StanceCategory, number>;
  warning: 'none' | 'low_diversity' | 'single_source';
  recommendation: 'proceed' | 'inject_contrarian' | 'broaden_scope';
}
```

---

## Vercel Function — `api/simulate/generate-personas.ts`

**Fully self-contained. No local imports. All helpers defined inline.**

### Request body
```typescript
{
  seedGraph: SeedGraph;
  config: SimulationConfig;
  userId: string;
}
```

### Response
```typescript
{
  personas: SimulationPersona[];
  diversity: PersonaSetDiversity;
}
```

### Logic

**Step 1 — Filter eligible nodes**
Filter `seedGraph.nodes` for entity_type in `['person', 'organization', 'team']`. Sort: anchor nodes first, then by edge count descending. Cap at 30.

**Step 2 — Build inter-agent relationship map**
For each eligible node, query `seedGraph.edges` for edges where both source and target are in the eligible set. Produce plain-language summaries from `relation_type`: "Competitor of [Label]", "Collaborates with [Label]", "Reports to [Label]".

**Step 3 — Evidence extraction (one Gemini call per agent)**
For each node, assemble linked source chunks from `seedGraph.source_chunks`. Pass to Gemini:

```
You are extracting evidence about a specific entity from source documents.

Entity: {node.label} ({node.entity_type})
Question being investigated: {config.question}

Source material:
{linked_chunks_content}

Return JSON only — no preamble, no markdown:
{
  "documented_position": "One sentence: what do these sources say this entity has said or done relevant to the question? If nothing relevant, state that explicitly.",
  "stance_category": "pro | anti | conditional | uncertain | orthogonal",
  "topic_proximity": 0.0–1.0,
  "source_count": integer,
  "grounding_quality": "strong | moderate | weak | inferred"
}

grounding_quality rules:
- strong: 3+ sources with direct relevance
- moderate: 1–2 directly relevant sources
- weak: sources exist but are tangential
- inferred: no relevant sources — derive from entity type and relationships only
```

Temperature: 0.1. If parse fails, set grounding_quality to 'inferred' and documented_position to "No directly relevant sources found."

**Step 4 — Persona synthesis (one Gemini call per agent)**
Mode-aware directive injected into the system prompt:

| Mode | Directive |
|---|---|
| prediction | "Reason probabilistically. Estimate likelihoods. Be willing to update when shown evidence." |
| hypothesis_test | "The hypothesis is: {question}. Evaluate it critically. State whether you support or refute it and why." |
| contrarian_scan | "Your role is to surface what others overlook. Challenge consensus. Prioritise minority positions and weak signals." |
| optimisation | "Evaluate options rather than predict outcomes. Reason from your incentives about which path best serves your interests." |
| consensus_mapping | "Find common ground. Identify what you can agree on with others. Resolve rather than amplify contradictions." |

Surprise sensitivity directive appended:
- expansive: "Consider second and third-order effects. What would have to be true for an unexpected outcome? What does conventional wisdom get wrong?"
- conservative: "Only surface claims you can directly ground in the source material. Flag speculation explicitly."

Synthesis prompt:

```
You are building a simulation agent profile for a multi-agent deliberation.

Entity: {node.label} ({node.entity_type})
Influence tier: {influence_tier}
Documented position: {documented_position}
Relationships to other agents: {inter_agent_relationships}
Question: {config.question}
What-if conditions: {config.whatIfVariables}

{mode_directive}
{sensitivity_directive}

Return JSON only — no preamble, no markdown:
{
  "question_specific_stance": "Their specific position on the question. One sentence. Evidence-grounded.",
  "incentive_structure": "What they gain or lose from each possible outcome. One sentence.",
  "epistemic_style": "empirical | ideological | opportunistic | contrarian | cautious | structural",
  "update_conditions": "What specific evidence or argument would cause them to revise their position. One sentence.",
  "blind_spots": "What they are systematically unlikely to see or acknowledge. One sentence.",
  "behavioural_prompt": "3–4 sentence system prompt governing this agent's behaviour in the simulation. Written in second person. Incorporates all of the above."
}
```

Temperature: 0.3.

**Step 5 — External agents**
For each `config.externalAgents`, construct a `SimulationPersona` directly — no Gemini calls. Set `is_synthetic: true`, `grounding_quality: 'inferred'`, `documented_position` from `known_position`. Derive `stance_category` heuristically. Set `influence_tier: 'medium'`. Construct `behavioural_prompt` from name, entity_type, and known_position.

**Step 6 — Diversity scoring**
Embed each persona's `question_specific_stance` using `text-embedding-004`. Compute average pairwise cosine distance → `diversity.score`.

Set `diversity.warning`:
- `low_diversity` if score < 0.25 OR all agents fall within two stance categories
- `single_source` if > 70% of grounding chunks come from one source_id
- `none` otherwise

Set `diversity.recommendation`:
- `inject_contrarian` if low_diversity
- `broaden_scope` if single_source
- `proceed` otherwise

---

## Stage State Machine (`useSimulate.ts`)

```typescript
type SimulationStage =
  | 'idle'
  | 'generating_personas'
  | 'awaiting_review'
  | 'confirmed'
  | 'running_simulation'
  | 'generating_report'
  | 'complete'
  | 'failed';
```

State also holds:
```typescript
personas: SimulationPersona[];
diversity: PersonaSetDiversity | null;
excludedAgentIds: Set<string>;
activeRound: number;
roundLog: { round: number; label: string; updatedAgentCount: number }[];
```

**Flow:**
1. User clicks Run → stage = `generating_personas` → call `POST /api/simulate/generate-personas`
2. Response received → stage = `awaiting_review`
3. User clicks "Run simulation" → stage = `confirmed` → POST to sidecar (personas minus excluded)
4. Sidecar returns `{ status: 'accepted' }` → stage = `running_simulation`
5. Supabase realtime: `status = generating_report` → stage = `generating_report`
6. Supabase realtime: `status = completed` → stage = `complete`

---

## UI — `PipelineStages.tsx`

Horizontal indicator at top of runner view. Four stages:

```
[Agents]  →  [Simulation]  →  [Report]  →  [Done]
```

- Completed: checkmark, secondary text, clickable (scrolls to stage output)
- Active: pulsing accent dot, accent text
- Pending: empty dot, muted text

Completed stages remain visible and scrollable throughout — agent cards do not disappear when simulation begins.

---

## UI — `AgentCard.tsx`

Staggered fade-in on render (0.05s delay per card, 0.4s ease). Cards sorted: high influence → medium → low. Synthetic agents grouped at bottom under "External participants" section label.

**Card anatomy:**
- Header: entity type badge · agent name (Cabinet Grotesk 15px) · influence tier pill · grounding indicator
- Grounding indicator: green dot + "X sources" (strong/moderate) · amber dot + "Weakly grounded" (weak) · grey "Synthetic" badge (inferred/is_synthetic)
- Epistemic style: small secondary badge
- "On this question:" label + question_specific_stance in primary text, DM Sans 13px
- Documented position in secondary text, DM Sans 13px
- Expandable section (collapsed): update_conditions · blind_spots · incentive_structure — each labelled
- Exclude toggle: ghost button top-right corner. Excluded cards: muted opacity, name struck through. Excluded agents remain visible.

---

## UI — `AgentReview.tsx`

Agent card list + sticky review footer.

**Review footer:**
- Diversity label: "Strong diversity" (green) / "Low diversity" (amber) / "Single-source bias" (amber)
- Stance distribution pills: "3 Pro · 2 Anti · 2 Conditional"
- Warning block (if `diversity.warning !== 'none'`): amber inset box with recommendation text
- Agent count: "X of Y agents active" — updates live as user excludes
- Buttons: "Run simulation" (primary accent, disabled if 0 active) · "Back to setup" (ghost)

---

## Sidecar Contract Update

### `main.py` — add `personas` to Pydantic model

```python
class SimulateRequest(BaseModel):
    seed_graph: dict
    question: str
    what_if_variables: list[str] = []
    config: dict = {}
    personas: list[dict] = []   # NEW
```

### `persona_gen.py` — stub out

```python
def generate_personas(seed_graph, question, personas_override=None):
    if personas_override:
        return personas_override  # use Synapse-generated personas
    # existing logic retained for standalone sidecar runs
    ...
```

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Zero eligible nodes in scope | Skip persona generation. Warning: "No Person, Organisation, or Team nodes in scope. Simulation will run on world context only." Not a blocker. |
| All agents excluded by user | Run button disabled: "At least one agent must be active." |
| Gemini call fails for one agent | Set grounding_quality = 'inferred', write minimal behavioural_prompt from label + entity_type. Do not block full generation. |
| generatePersonas times out | Stage fails: "Agent generation timed out. Try reducing scope." Offer Back to setup only. |
| Diversity warning, user proceeds | Log `diversity_override: true` to `simulation_jobs.config`. Appears in report header. |
| User excludes all weakly grounded agents | Recalculate diversity score on remaining set. Update footer live. |

---

## Acceptance Criteria

- Clicking Run triggers `generate-personas` before any sidecar call
- Agent cards render with all fields: name, entity type, influence tier, grounding quality, epistemic style, documented position, question-specific stance
- Expandable section shows update conditions, blind spots, incentive structure
- User can exclude agents; excluded agents are muted but remain visible
- Diversity score and stance distribution shown in review footer
- Low diversity and single-source warnings appear with recommendation text
- Simulation does not proceed until user clicks "Run simulation" on the review screen
- Sidecar POST payload includes the `personas` array (minus excluded agents)
- Sidecar `persona_gen.py` uses incoming personas when provided, self-generates as fallback
- Stage indicator shows correct active/complete/pending states throughout
- Agent cards remain visible and scrollable after simulation stage begins
- `diversity_override: true` is logged to simulation_jobs.config when user proceeds past a diversity warning
