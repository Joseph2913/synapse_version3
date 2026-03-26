# Simulate — Core Principles & Implementation Guide

**Status:** Design specification — pre-implementation  
**Scope:** All layers of the Simulate pipeline, from scope selection to report visualisation  
**Purpose:** Every decision made across agent creation, simulation execution, analysis, report generation, and UI rendering must be evaluated against these principles. This document is the governing reference.

---

## The Three Governing Principles

Every layer of the pipeline must satisfy all three. If a layer satisfies two but not the third, it is not good enough.

---

### Principle 1 — Specificity Over Coverage

**Definition:** Every output — every forecast, every agent move, every unexpected signal — must be specific enough to be falsifiable. A claim that cannot be proven wrong is not a forecast; it is an opinion dressed as analysis.

**The test:** Can a user return to this report in six months and verify whether this claim came true or not? If not, the claim must be made more specific or discarded.

**What this rules out:**
- Category statements ("demand for X will increase")
- Directionless predictions ("the landscape will shift")
- Unanchored timeframes ("in the medium term")
- Claims that would be true regardless of how the simulation ran

**What this requires:**
- Named entities, named roles, named conditions wherever possible
- Time-bounded claims with trigger conditions, not just calendar ranges
- Verification conditions — one sentence per forecast telling the user exactly what to look for to confirm or deny the prediction
- Magnitude where relevant — not "adoption will grow" but "adoption will reach [threshold] in [sector] by [date]"

---

### Principle 2 — Evidence Traceability

**Definition:** Every claim in the output must have a traceable path back to: (a) source chunks from the user's knowledge graph, (b) agent interactions that processed that knowledge, and (c) the reasoning chain that connected them to the conclusion.

**The test:** Can a user click on any claim in the report and see exactly which sources, which agents, and which interactions produced it? If not, the pipeline has not captured enough provenance.

**What this rules out:**
- Conclusions that emerge from generic LLM knowledge rather than the user's specific ingested content
- Reports that summarise without attribution
- Confidence scores that are labels rather than calculations
- Agent behaviours that are not grounded in the personas derived from graph nodes

**What this requires:**
- Every agent persona linked to the specific node and source chunks that created it
- Every simulation interaction logged with the agent, round, and content
- Every forecast tagged with: agent consensus percentage, source count, contradiction count
- Source trails accessible from every claim — not buried, always one click away
- Confidence scores expressed as percentages with visible anatomy (consensus + corroboration + contradiction breakdown)

---

### Principle 3 — Emergence Over Synthesis

**Definition:** The simulation must produce outputs that the user could not have derived themselves by reading their own sources. If the report contains only things already implicit in the ingested content, the simulation added no value — it was just a summariser.

**The test:** For each claim in the report, ask: could this have been written without running the simulation? If yes, it should not be the lead finding. It may still be included as corroboration, but the report must lead with what is genuinely new.

**What this rules out:**
- Signals that repeat consensus views already present in the source material
- Unexpected signals that are well-known industry theses
- Agent moves that are obvious extrapolations of publicly known positions
- Tension maps that show no genuine disagreement

**What this requires:**
- The simulation must actively create conditions for agents to *disagree, update, and surprise each other*
- The round structure must include revision passes — agents must read what others said and have the opportunity to change their position
- The report must distinguish between consensus findings (expected but corroborated) and emergent findings (produced by interaction, not present in any single source)
- Unexpected signals must pass an emergence test: did this arise from agent interaction, or was it present in the source material before the simulation ran?

---

## Layer-by-Layer Implementation

---

### Layer 1 — Scope Selection & Input Collection

**Purpose:** Establish the knowledge boundary, the question, and the simulation configuration. Everything downstream depends on the quality of what is collected here.

#### Governing principles applied:

**Specificity** — The prediction question must be specific enough to produce falsifiable forecasts. A vague question produces vague outputs regardless of simulation quality. At input time, the system should evaluate the question and warn the user if it is too broad. A well-formed question names at least one entity, one domain, and one temporal horizon.

**Evidence traceability** — The scope selection must capture which anchors, which time window, and which source types were included. This metadata travels with the simulation job and is displayed in the report header. The user must always know what the simulation was and was not grounded in.

**Emergence** — Simulation configuration (mode, depth, surprise sensitivity) directly controls whether emergence is possible. Shallow depth and conservative surprise sensitivity actively suppress emergence. The UI must make the tradeoff visible — the user should understand that Quick Scan produces corroboration, not discovery.

#### Inputs to collect:

| Input | Purpose | Notes |
|---|---|---|
| Anchor nodes | Define the agents and the scope centroid | Multiple anchors allowed; each anchor is a simulation participant |
| Time window | Set the knowledge boundary | Controls which source chunks are eligible |
| Source type filter | Control knowledge grounding | All types by default; user can restrict to meetings-only, documents-only etc. |
| Prediction question | The central research question | Must be specific enough to be falsifiable — system flags if too broad |
| What-if variables | Environmental conditions injected as facts | Distinct from agents — these are conditions, not participants |
| External agents | Entities not in the graph but relevant | Injected as synthetic personas with user-defined position |
| Simulation mode | Prediction / Hypothesis Test / Contrarian Scan / Optimisation / Consensus Mapping | Governs agent orientation and report framing |
| Simulation depth | Quick Scan / Standard / Deep Dive / Exhaustive | Controls round count and round question type |
| Surprise sensitivity | Conservative / Balanced / Expansive | Controls signal threshold and emergent signal weighting |
| Output horizon | When should the prediction be valid for | Separate from the input time window |
| Perspective anchor | Whose vantage point should the report prioritise | Optional; defaults to omniscient |

#### What gets persisted:
All inputs are stored in `simulation_jobs` alongside the seed graph. The report is always reproducible and auditable from these stored inputs.

---

### Layer 2 — Seed Graph Construction

**Purpose:** Build the subgraph that grounds the entire simulation. This is the factual universe the agents inhabit.

#### Governing principles applied:

**Specificity** — The seed graph must not be so large that it becomes generic. 150-node cap enforced by centrality ranking preserves the most relevant knowledge while preventing dilution.

**Evidence traceability** — Source chunk selection must be logged. The simulation job must record exactly which chunk IDs were included, so the report's evidence trails can be verified against actual ingested content.

**Emergence** — Source chunk diversity matters as much as volume. If all chunks come from one source, agents will converge trivially. The environment assembly should maximise source diversity within the cap — sampling across sources, not exhausting one source before moving to the next.

#### Implementation requirements:

- Cap nodes at 150, ranked by centrality (edge count as proxy)
- Use `get_scoped_edges` RPC for edge fetching — never pass node ID lists via URL parameters
- Sample source chunks across sources (up to 3 per source) before exhausting any single source
- Apply recency weighting when `recency_weight` is enabled in simulation config
- Apply minimum evidence threshold — exclude nodes below confidence threshold or with fewer than N source connections if configured
- Log all included chunk IDs and node IDs to `simulation_jobs.seed_graph_metadata`
- Respect source type filter from scope selection

---

### Layer 3 — Agent Creation (Persona Generation)

**Purpose:** Derive simulation participants from the graph. Each agent must carry a behavioural identity grounded in what Synapse actually knows about that entity — not a generic description.

#### Governing principles applied:

**Specificity** — Generic personas produce generic agent behaviour. Each persona must encode: what this entity has actually said or done (from source chunks), what their known position is on relevant topics, what their incentive structure is, and how they characteristically respond to challenge or uncertainty.

**Evidence traceability** — Every persona must be linked to the specific node and the source chunk IDs that informed it. If a user questions why an agent said something, the trail leads back to the ingested content.

**Emergence** — Agent diversity is the precondition for emergence. If all agents share similar priors, they will converge immediately and produce no novel outputs. The persona generation step must actively maximise epistemic diversity — if the graph skews toward one perspective, the system should flag this and optionally inject a synthetic contrarian agent.

#### Persona structure (per agent):

```
{
  agent_id: node.id,
  label: node.label,
  entity_type: node.entity_type,
  influence_tier: "high" | "medium" | "low",  // derived from anchor status + centrality
  grounding_chunks: [chunk_id, ...],           // source chunks used to build this persona
  position_summary: string,                    // what this entity's known position is on the topic
  behavioural_prompt: string,                  // 3–5 sentence prompt governing simulation behaviour
  known_relationships: [edge summary, ...],    // key graph relationships relevant to the question
  incentive_structure: string,                 // what does this entity gain or lose from each outcome
  epistemic_style: string                      // how does this entity reason: data-driven, ideological, opportunistic etc.
}
```

#### Persona generation prompt requirements:

The LLM call generating each persona must be grounded in:
- The node's label, type, description, and confidence score
- The source chunks linked to that node
- The prediction question — the persona must be calibrated to the *specific question*, not just the entity in general
- The simulation mode — a Contrarian Scan persona is prompted differently than a Consensus Mapping persona

The prompt must explicitly instruct the model to:
- Derive the position from the source evidence, not from general world knowledge
- Identify one thing this agent would push back on
- Identify one thing this agent would be wrong about
- Identify what early signal would cause this agent to update their position

#### Epistemic diversity check:

Before proceeding to simulation, calculate the variance across agent positions. If variance is below threshold (agents are too aligned), flag to the user and offer to inject a synthetic contrarian agent with a user-defined position. This is not a failure state — it is a legitimate finding (the graph has a strong consensus) — but the user should know.

---

### Layer 4 — Environment Setup

**Purpose:** Assemble the world context that all agents operate within. This is the shared factual ground truth of the simulation.

#### Governing principles applied:

**Specificity** — The world context must be assembled to serve the specific question, not as a general dump of source content. Chunk selection should be weighted toward content that is directly relevant to the prediction question and the simulation's time horizon.

**Evidence traceability** — The assembled world context is stored in full with the simulation job. Every agent interaction references this same grounding — it is the stable factual foundation all provenance chains lead back to.

**Emergence** — What-if variables must be injected as environmental facts that agents cannot ignore — they must respond to them. A what-if variable that has no material effect on agent behaviour was not properly injected.

#### Assembly requirements:

- Sample chunks across sources for maximum diversity (not depth-first per source)
- Weight toward recency if recency weighting is enabled
- Weight toward chunks semantically proximate to the prediction question (embed the question, rank chunks by cosine similarity)
- Inject what-if variables as explicit environmental conditions: "For the purpose of this simulation, the following conditions are established as facts: [variables]"
- Inject external agents as synthetic world facts: "The following entity is also a participant in this environment: [definition]"
- Cap world context at ~32,000 characters; log actual character count and chunk count to simulation job
- The assembled world context is not summarised or compressed — it is passed in full to the simulation runner

---

### Layer 5 — Simulation Execution (Agent Interaction Rounds)

**Purpose:** Run the actual multi-agent deliberation. This is where emergence either happens or does not. The round structure is the most important determinant of output quality.

#### Governing principles applied:

**Specificity** — Each round must ask agents a specific question that advances the deliberation. Generic prompts ("what do you think?") produce generic outputs. Round questions should escalate in depth and confrontation as rounds progress.

**Evidence traceability** — Every agent response in every round must be logged: agent ID, round number, prompt, response, and whether the agent updated their position from the previous round. This interaction log is the raw material for the report's evidence trails and tension map.

**Emergence** — Round structure must create the conditions for agents to surprise each other. This means: agents must read what others said before responding; they must be explicitly asked whether they revise their position; minority positions must receive a dedicated challenge round; agents must be asked to consider second and third-order effects.

#### Round structure by depth tier:

**Quick Scan (2–3 rounds):**
- Round 1: "Given the world context and your known position, what is your immediate read on [question]?"
- Round 2: "Having read the other agents' positions, do you revise your read? State your final position."

**Standard (5–6 rounds):**
- Round 1: Initial position statement
- Round 2: Response to other agents — agreements and disagreements
- Round 3: Revision pass — state updated position with rationale
- Round 4: Identify the strongest argument against your position
- Round 5: Final position with confidence level

**Deep Dive (8–10 rounds):**
- Rounds 1–3: As Standard
- Round 4: Minority position challenge — agents holding minority views present their case to the majority
- Round 5: Majority agents respond to the minority challenge
- Round 6: Each agent identifies what evidence would change their mind
- Round 7: Second-order effects — what happens *because of* the primary forecasts?
- Round 8: Final positions

**Exhaustive (12–15 rounds):**
- Rounds 1–8: As Deep Dive
- Round 9: Coalition formation — which agents agree and why; which agents fundamentally disagree and why
- Round 10: Hinge conditions — what single condition would flip the majority outcome?
- Round 11: Third-order effects and black swans
- Round 12: Final falsifiable positions with verification conditions
- Round 13: Consensus check — what do all agents agree on regardless of other disagreements?

#### Surprise sensitivity implementation:

**Conservative:** Agents are instructed to only surface claims supported by the world context. Speculation beyond the evidence base is flagged and suppressed.

**Balanced:** Agents may extrapolate one step beyond the evidence with explicit labelling ("this is not directly evidenced but logically follows from...").

**Expansive:** Agents are explicitly instructed: "Consider second and third-order effects. Surface what others would overlook. What would have to be true for an unexpected outcome to occur? What is the conventional wisdom that this evidence actually undermines?"

#### Simulation mode implementation:

Each mode changes the core directive in every agent's system prompt:

| Mode | Core Agent Directive |
|---|---|
| Prediction | "Your goal is to determine what is most likely to happen. Converge toward probability-weighted outcomes." |
| Hypothesis Test | "The hypothesis is [X]. Your goal is to find evidence that supports or refutes it. State your verdict with reasoning." |
| Contrarian Scan | "Your goal is to find what everyone else is getting wrong. Surface minority positions, overlooked signals, and consensus blind spots." |
| Optimisation | "Given this situation, evaluate the available courses of action. Recommend the best path and explain why alternatives are inferior." |
| Consensus Mapping | "Your goal is to identify what the evidence actually agrees on. Resolve contradictions. Surface only high-confidence shared signals." |

#### Logging requirements (per interaction):

```
{
  job_id: string,
  agent_id: string,
  round_number: integer,
  round_type: string,           // "initial" | "response" | "revision" | "challenge" | "final"
  prompt: string,               // the exact prompt this agent received
  response: string,             // the agent's response
  position_delta: string,       // "unchanged" | "updated" | "reversed"
  position_summary: string,     // one-sentence summary of current stance
  confidence: number,           // 0–1 agent's stated confidence in their position
  grounding_chunks: [string],   // which world context chunks the agent cited
  timestamp: string
}
```

This log is the provenance foundation for the entire report. It must be complete before report generation begins.

---

### Layer 6 — Report Generation (Analysis)

**Purpose:** Synthesise the interaction log into a structured, evidence-grounded, falsifiable report. This is not a summarisation step — it is an analytical step. The report generator has access to everything that happened in the simulation and must produce outputs that only that simulation could have produced.

#### Governing principles applied:

**Specificity** — The report generator must be explicitly instructed to refuse generic claims. Every forecast must name an entity, a mechanism, a timeframe, and a verification condition. The prompt must include examples of unacceptable vagueness and require the generator to self-check before outputting each claim.

**Evidence traceability** — Every claim in the report must be tagged with: the agent IDs that support it, the round numbers where it emerged, the source chunk IDs that grounded it, and the number of agents that contradicted it. This tagging is not optional — it is part of the JSON schema.

**Emergence** — The report must explicitly distinguish between two claim types:
- **Corroborated claims** — findings already implicit in the source material that the simulation confirmed
- **Emergent claims** — findings that arose from agent interaction and were not present in any single source

The emergence label is assigned by the report generator based on whether the claim appears in the world context pre-simulation or only in the interaction log.

#### Report JSON schema (full):

```json
{
  "simulation_header": {
    "question": "string",
    "mode": "string",
    "depth": "string",
    "surprise_sensitivity": "string",
    "agent_count": "integer",
    "source_count": "integer",
    "chunk_count": "integer",
    "time_window": "string",
    "output_horizon": "string",
    "overall_confidence": "number (0–100)",
    "confidence_anatomy": {
      "agent_consensus_pct": "number",
      "source_corroboration_count": "integer",
      "contradiction_count": "integer",
      "rationale": "string"
    },
    "key_tension": "string"
  },

  "forecasts": [
    {
      "claim": "string — specific, named, time-bounded",
      "mechanism": "string — causal chain from evidence to outcome",
      "timeframe": "string — trigger-based, not just calendar range",
      "verification_condition": "string — exactly what to look for to confirm or deny",
      "confidence": "number (0–100)",
      "confidence_anatomy": {
        "agent_consensus_pct": "number",
        "supporting_agent_ids": ["string"],
        "contradicting_agent_ids": ["string"],
        "source_chunk_ids": ["string"],
        "contradiction_summary": "string"
      },
      "claim_type": "corroborated | emergent",
      "emergence_note": "string — if emergent, explain how it arose from agent interaction"
    }
  ],

  "agent_moves": [
    {
      "agent_id": "string",
      "agent_label": "string",
      "entity_type": "string",
      "influence_tier": "high | medium | low",
      "predicted_action": "string — specific and consequential",
      "mechanism": "string — why this agent would take this action, grounded in their known position",
      "signal_to_watch": "string — early indicator that this is beginning to happen",
      "confidence": "number (0–100)",
      "position_type": "consensus | minority",
      "supporting_agent_ids": ["string"],
      "grounding_chunk_ids": ["string"]
    }
  ],

  "tension_map": {
    "key_conflicts": [
      {
        "agent_ids": ["string", "string"],
        "description": "string — what they disagreed on and why it matters",
        "resolution_dependency": "string — what condition would resolve this conflict in each direction"
      }
    ],
    "hinge_conditions": [
      {
        "condition": "string — the specific condition",
        "if_true": "string — which forecast cluster becomes more likely",
        "if_false": "string — which forecast cluster becomes more likely",
        "probability_of_condition": "number (0–100)"
      }
    ]
  },

  "unexpected_signals": [
    {
      "signal": "string — specific emergent claim",
      "why_unexpected": "string — what prior assumption it violates",
      "violated_assumption_source_ids": ["string"],
      "emergence_chain": "string — how this arose from agent interactions step by step",
      "fragility": "high | medium | low",
      "fragility_note": "string — how dependent is this signal on a single agent or condition"
    }
  ],

  "graph_implications": {
    "suggested_new_nodes": [
      {
        "label": "string",
        "entity_type": "string",
        "rationale": "string",
        "source_simulation_round": "integer"
      }
    ],
    "weakened_connections": [
      {
        "source_node_id": "string",
        "target_node_id": "string",
        "rationale": "string",
        "agent_ids": ["string"]
      }
    ],
    "reinforced_connections": [
      {
        "source_node_id": "string",
        "target_node_id": "string",
        "rationale": "string",
        "corroborating_chunk_ids": ["string"]
      }
    ],
    "blind_spots": [
      {
        "topic": "string",
        "description": "string — appeared in agent reasoning but not in graph",
        "frequency": "integer — how many agents referenced this topic"
      }
    ]
  }
}
```

#### Report generator prompt requirements:

The LLM system prompt for report generation must explicitly:
- Instruct the model to produce only claims that are specific enough to be falsifiable
- Require a verification condition for every forecast — no exceptions
- Require the model to distinguish corroborated from emergent claims
- Instruct the model to build the tension map from actual agent disagreements in the log, not from synthetic conflicts
- Require the unexpected signals section to contain only things that contradict the pre-simulation world context
- Set temperature to 0.2 for forecasts and agent moves; 0.4 for unexpected signals (slight creativity budget for emergence)
- Require the model to self-check each claim against the three governing principles before including it

---

### Layer 7 — Report Visualisation (UI)

**Purpose:** Present the report in a way that makes its evidence base navigable, its findings scannable, and its provenance transparent. The UI is not decoration — it is part of how the three principles are delivered to the user.

#### Governing principles applied:

**Specificity** — The UI must make the specificity of each claim immediately visible. Claims that are vague enough to be unverifiable should never render unchallenged. If a claim fails the falsifiability test at generation time, it is excluded — not displayed with a caveat.

**Evidence traceability** — Every claim must have a one-click path to its evidence. This is not a feature — it is a UI requirement. Source trails, agent interaction logs, and chunk references must be accessible without leaving the report view.

**Emergence** — Emergent claims must be visually distinguished from corroborated claims. The user must immediately know which findings are novel (arose from simulation) vs confirmatory (already in their sources).

#### Section-by-section UI requirements:

**Simulation Header**
- Question displayed verbatim in a block quote style
- Configuration badges: mode, depth, surprise sensitivity — visible and labelled
- Overall confidence as a percentage ring or score, not a coloured dot
- Confidence anatomy expandable: consensus / corroboration / contradiction breakdown
- Key tension displayed prominently as a highlighted callout — this is the most important single sentence in the report

**Forecasts**
- Each forecast as a card with a coloured left border: green = high confidence, amber = medium, red = low (not entity type colours — semantic)
- Claim text in Cabinet Grotesk, 16px, primary colour
- Timeframe as a pill — trigger-based language, not just dates
- Verification condition in a distinct inset box within the card — labelled "How to verify"
- Confidence as a percentage, with a collapsed anatomy chip ("7 agents · 4 sources · 2 contradictions")
- Expanding the chip reveals: supporting agent names, contradicting agent names with summary of their objection, source chunk previews
- Emergent claims get a distinct marker — a small "Emergent" badge in accent colour; corroborated claims get no badge (corroboration is the default expectation)

**Agent Moves**
- Each move as a card with entity type badge (using existing entity type colour system)
- "[Agent name] is likely to [action]" headline — action must be specific
- Mechanism in body text — one sentence, evidence-grounded
- "Signal to watch" in a distinct inset — labelled with an eye icon
- Position type: consensus vs minority — minority position cards get a distinct visual treatment (subtle amber tint, "Minority position" label)
- Confidence percentage visible on card face

**Tension Map**
- Rendered as a visual conflict diagram — agent nodes connected by lines labelled with the nature of the disagreement
- Each conflict expandable to show the full disagreement narrative
- Hinge conditions listed below the diagram as conditional statements: "If [A] → [Cluster 1 likely] / If not [A] → [Cluster 2 likely]"
- Hinge conditions should be the most actionable element of the entire report — they tell the user what to watch

**Unexpected Signals**
- Amber/gold left border (distinct from forecast colours)
- Signal statement in body
- "Why unexpected" in a callout — referencing the specific prior assumption it violates, with a link to the source that holds that assumption
- Emergence chain collapsible — shows the step-by-step agent interaction path
- Fragility indicator: high fragility signals are explicitly labelled as "Dependent on single agent position"

**Graph Implications**
- Suggested new nodes: each with an "Add to graph" action button — one click adds to extraction review queue
- Weakened connections: displayed as relationship pairs with a "Review" button — surfaced to the user as something to verify, not automatically acted on
- Reinforced connections: displayed with corroboration count
- Blind spots: listed with frequency count — sorted by how many agents referenced them

#### Additional UI requirements:

- The full interaction log must be accessible from the report via a "View simulation log" toggle — collapsed by default, not hidden
- All source chunk references must be hyperlinks to the source in the Explore view
- The report must display the simulation configuration summary at the top — always auditable
- "Re-run with same scope" must preserve all configuration settings, not just anchors and question
- "Re-run with different configuration" must pre-populate the setup wizard with current settings for easy modification
- Report generation timestamp and simulation duration are always visible

---

## Cross-Layer Quality Gates

Before proceeding from one layer to the next, these gates must pass:

| Gate | From Layer | To Layer | Condition |
|---|---|---|---|
| Question specificity check | Input Collection | Seed Graph | Prediction question names at least one entity and one temporal horizon |
| Persona diversity check | Agent Creation | Environment Setup | Variance across agent positions exceeds minimum threshold |
| Source diversity check | Environment Setup | Simulation | At least 3 distinct sources represented in world context |
| Interaction log completeness | Simulation | Report Generation | All rounds logged for all agents; no empty responses |
| Claim falsifiability check | Report Generation | Report Visualisation | All forecasts have verification conditions; no category statements present |
| Evidence tagging completeness | Report Generation | Report Visualisation | All claims tagged with agent IDs and source chunk IDs |

If any gate fails, the pipeline surfaces the failure to the user with a specific explanation — not a generic error. The user should always know *why* a simulation did not meet quality standards and what they can do to address it.

---

## What These Principles Rule Out (Summary)

| Pattern | Why It Violates the Principles |
|---|---|
| Category statements as forecasts | Violates Specificity — cannot be falsified |
| Confidence labels instead of scores | Violates Evidence Traceability — no anatomy |
| Reports without source citations | Violates Evidence Traceability — no provenance path |
| Unexpected signals that are known theses | Violates Emergence — not produced by simulation |
| Single-round simulations for deep questions | Violates Emergence — no revision, no disagreement |
| Generic personas not grounded in node data | Violates Evidence Traceability and Emergence |
| World context assembled from one source | Violates Emergence — agents will trivially converge |
| Forecasts without verification conditions | Violates Specificity — cannot be acted on |
| Tension map constructed synthetically | Violates Evidence Traceability — must come from actual log |
| Graph implications not linked to source nodes | Violates Evidence Traceability — cannot be verified |
