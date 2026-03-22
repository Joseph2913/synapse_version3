# PRD-Simulate-C — Input Collection Redesign

**Phase:** Simulate overhaul  
**Dependencies:** PRD-Simulate-A (existing SimulateView, ScopeSelector, PredictionInput components)  
**Reference documents:** `SIMULATE-FEATURE.md` (current implementation) · `SIMULATE-PRINCIPLES.md` (governing principles)  
**Complexity:** Medium

---

## Objective

Replace the current minimal scope selector with a structured, multi-step configuration wizard. The goal is to collect all inputs required to run a principled simulation — one that produces specific, traceable, emergent outputs as defined in `SIMULATE-PRINCIPLES.md`. This PRD covers the UI and data collection only. Persona generation and pipeline changes are handled in PRD-Simulate-D onwards.

---

## What Gets Built

### Files Modified
- `src/components/simulate/ScopeSelector.tsx` — extended with new fields
- `src/components/simulate/PredictionInput.tsx` — extended with question quality check and what-if variables
- `src/services/simulate.ts` — `SimulationConfig` type extended, `buildSeedGraph` updated
- `simulation_jobs` Supabase table — `config` JSONB column added (see Data section)

### Files Created
- `src/components/simulate/SimulationConfig.tsx` — new step 3 of the wizard (mode, depth, surprise sensitivity)
- `src/components/simulate/ExternalAgents.tsx` — optional external agent injection UI
- `src/components/simulate/ConfigSummary.tsx` — confirmation screen before Run

---

## Wizard Structure

The setup flow is three steps displayed as a horizontal step indicator at the top of the SimulateView setup panel. Steps are validated before proceeding to the next.

```
[1. Scope]  →  [2. Question]  →  [3. Configuration]  →  [Confirm & Run]
```

---

## Step 1 — Scope (modifies `ScopeSelector.tsx`)

**Existing fields kept:** anchor node selector, time window picker.

**New fields:**

**Source type filter** — multi-select pill group. Options: All (default), Meetings, Documents, YouTube, Notes. When anything other than All is selected, show a live count of how many source chunks are included.

**Output horizon** — separate from the time window. Dropdown: 30 days / 90 days / 6 months / 1 year / 2+ years. Defaults to 90 days. Label: "Forecast should be valid for."

**Scope preview** — already exists but add: source type breakdown (e.g. "12 meeting chunks · 8 document chunks · 5 YouTube chunks") and a grounding quality indicator: if fewer than 3 distinct sources are in scope, show an amber warning — "Low source diversity may limit emergence."

---

## Step 2 — Question (modifies `PredictionInput.tsx`)

**Existing fields kept:** prediction question textarea.

**Question quality gate** — on blur of the question field, run a lightweight client-side check (regex + word count heuristics). Flag the question as too broad if it contains no named entity OR no temporal reference. Show inline warning: "Strong questions name at least one entity and a timeframe. Example: 'Will [entity] expand into [market] within 18 months?'" This is a warning, not a blocker — the user can proceed.

**What-if variables** — below the question. Label: "Environmental conditions." A repeatable field: `+ Add condition`. Each condition is a single text input. Example placeholder: "Assume GPT-5 launches in Q2 2026." Max 5 conditions. Each condition renders as a dismissible pill once entered. These are injected into the simulation as established facts, not as agents.

**External agents** — collapsible section below what-if variables. Label: "Add external participants." Renders `ExternalAgents.tsx`. See below.

### `ExternalAgents.tsx`

Allows the user to inject entities not in their graph as simulation participants. Each external agent requires:
- Name (text input)
- Entity type (dropdown using existing 24-type ontology)
- Known position on the question (text input, 1–2 sentences)

Max 3 external agents. Each renders as a card with a "Synthetic" badge. These are passed to the sidecar as additional persona objects.

---

## Step 3 — Configuration (`SimulationConfig.tsx`)

Three controls, each clearly labelled with a one-line description of what it changes.

### Simulation Mode
Single-select. Five options displayed as cards (not a dropdown). Each card shows: name, one-sentence description, best-for label.

| Mode | Description | Best for |
|---|---|---|
| Prediction | What is most likely to happen? Agents converge on probability-weighted outcomes. | Decision support |
| Hypothesis Test | Stress-test a specific belief. Agents evaluate supporting and refuting evidence. | Validating assumptions |
| Contrarian Scan | What is everyone getting wrong? Agents hunt for overlooked signals and minority positions. | Blind spot discovery |
| Optimisation | What should happen? Agents evaluate available courses of action. | Strategic planning |
| Consensus Mapping | What does the evidence actually agree on? Agents resolve contradictions. | Settling debates |

Default: Prediction.

### Simulation Depth
Single-select toggle group. Four options.

| Option | Rounds | Time estimate |
|---|---|---|
| Quick Scan | 2–3 | ~1 min |
| Standard | 5–6 | ~3 min |
| Deep Dive | 8–10 | ~6 min |
| Exhaustive | 12–15 | ~10 min |

Show time estimate next to each option. Default: Standard.

### Surprise Sensitivity
Single-select toggle group. Three options: Conservative / Balanced / Expansive. One-line description per option:
- Conservative: High-confidence findings only. Surprises section will be short.
- Balanced: Mix of confident forecasts and notable outlier signals.
- Expansive: Actively surfaces weak signals and second-order effects. Report will be longer and more speculative.

Default: Balanced.

**Presets** — above the three controls, show a row of preset chips. Selecting a preset sets all three controls simultaneously. Presets:

| Preset | Mode | Depth | Sensitivity |
|---|---|---|---|
| Quick Read | Prediction | Quick Scan | Conservative |
| Strategic Brief | Prediction | Standard | Balanced |
| Stress Test | Hypothesis Test | Deep Dive | Balanced |
| Blind Spot Hunt | Contrarian Scan | Deep Dive | Expansive |
| Scenario Planning | Optimisation | Exhaustive | Expansive |

Selecting a preset auto-fills the controls below. The user can then override individual controls. When a preset is active and a control is changed, the preset chip deselects (becomes unselected state) — the preset is a shortcut, not a lock.

---

## Confirmation Screen (`ConfigSummary.tsx`)

Shown before the Run button. A read-only summary of everything the user configured. Not a separate page — rendered below the three-step wizard on the same view.

Contents:
- Scope: anchor names, time window, source type filter, output horizon
- Question verbatim (truncated to 2 lines with expand)
- What-if conditions listed as pills
- External agents listed with their entity type and position
- Mode, Depth, Sensitivity as labelled badges
- Estimated agent count derived from node count in scope (Person + Org + Team nodes)
- Grounding quality summary: "X agents · Y sources · Z chunks"
- One-line natural language summary: "Running a [mode] at [depth] depth — [sensitivity description]."

Run button is disabled until: sidecar is healthy, at least one anchor is selected, question field is non-empty. Show specific reason for disabled state beneath the button.

---

## Data & Service Layer

### `SimulationConfig` type (extend in `simulate.ts`)

```typescript
interface SimulationConfig {
  // Scope
  anchorNodeIds: string[];
  timeWindow: '30d' | '90d' | '6m' | 'all';
  sourceTypeFilter: ('meetings' | 'documents' | 'youtube' | 'notes')[] | null;
  outputHorizon: '30d' | '90d' | '6m' | '1y' | '2y+';

  // Question
  question: string;
  whatIfVariables: string[];
  externalAgents: ExternalAgent[];

  // Simulation
  mode: 'prediction' | 'hypothesis_test' | 'contrarian_scan' | 'optimisation' | 'consensus_mapping';
  depth: 'quick_scan' | 'standard' | 'deep_dive' | 'exhaustive';
  surpriseSensitivity: 'conservative' | 'balanced' | 'expansive';
  presetUsed: string | null;
}

interface ExternalAgent {
  label: string;
  entity_type: string;
  known_position: string;
}
```

### `simulation_jobs` table — add column

```sql
ALTER TABLE simulation_jobs
ADD COLUMN config JSONB;
```

The full `SimulationConfig` object is written to this column when the job row is created. This is the audit trail for every simulation — always auditable from stored inputs per `SIMULATE-PRINCIPLES.md` Layer 1.

### `buildSeedGraph` update

Pass `sourceTypeFilter` from config to the source chunk query. If filter is non-null, add `.in('source_type', sourceTypeFilter)` to the chunks query. All other existing logic (150-node cap, `get_scoped_edges` RPC, centrality sort) unchanged.

### Sidecar payload update

The POST body to `/simulate` gains a `config` field containing the full `SimulationConfig`. The sidecar's Pydantic model must be updated to accept and forward this config to all pipeline stages. This is a breaking change to the sidecar contract — update `main.py` and the Pydantic model in the same PR.

---

## Design Tokens

All components use existing design system. Specific callouts:

- Step indicator: three dots connected by lines. Active step: accent-500 filled dot. Completed: secondary filled dot. Upcoming: empty dot with subtle border.
- Mode cards: white bg, subtle border, hover lifts. Selected: accent-50 bg, accent-500 border, accent text on label.
- Depth + sensitivity toggles: use existing toggle group pattern (inset container, white active item).
- Preset chips: use existing filter pill pattern. Active preset: accent-50 bg, accent border.
- Warning states (question quality gate, low source diversity): amber semantic colour, inline below the relevant field.
- ConfigSummary: inset bg (`--bg-inset`), 16px 22px padding, subtle border. Badges use existing pill pattern.
- External agent cards: white bg, subtle border, "Synthetic" badge in secondary colour.

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| No Person/Org/Team nodes in scope | Show warning on ConfigSummary: "No eligible agents found in scope. Simulation will use synthetic personas only." Not a blocker. |
| Sidecar unreachable | Run button disabled, inline message: "Simulation engine offline. Start the local sidecar to run." |
| Hypothesis Test mode selected with no hypothesis in what-if variables | Show inline tip: "Hypothesis Test works best when you add the specific belief you want to test as a what-if condition." Not a blocker. |
| User changes scope after reaching step 3 | Config step is reset to defaults. Show toast: "Scope changed — simulation settings reset." |
| Fewer than 3 sources in scope | Amber warning in scope preview. Carry warning through to ConfigSummary. |

---

## Acceptance Criteria

- User can complete the three-step wizard and reach the confirmation screen
- All `SimulationConfig` fields are written to `simulation_jobs.config` on job creation
- Selecting a preset fills all three controls; overriding a control deselects the preset
- Question quality gate fires on blur and shows inline warning for broad questions
- What-if variables can be added, edited, and removed as pills
- External agents can be added (max 3) and removed
- Source type filter changes are reflected live in the scope preview chunk count
- Run button is disabled with a specific reason when preconditions are not met
- Sidecar POST body includes the full config object
- Existing simulation behaviour (buildSeedGraph, polling, report rendering) is unaffected
