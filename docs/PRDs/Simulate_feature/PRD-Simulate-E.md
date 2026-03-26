# PRD-Simulate-E — Simulation Execution Engine

**Phase:** Simulate overhaul  
**Dependencies:** PRD-Simulate-C (SimulationConfig), PRD-Simulate-D (SimulationPersona, stage state machine, sidecar contract)  
**Reference documents:** `SIMULATE-FEATURE.md` (current sidecar implementation) · `SIMULATE-PRINCIPLES.md` (governing principles — Layer 5: Simulation Execution)  
**Complexity:** Very High

---

## Objective

Replace the current fallback-only simulation path with a fully operational OASIS-powered deliberation engine. Implement the round-based structure, moderator layer, hybrid interaction model, and structured interaction log. Deploy the sidecar to Railway on Python 3.12 so simulations run as hosted infrastructure with no execution timeout constraints. The output of this layer is a complete, structured interaction log that feeds directly into report generation (PRD-Simulate-F).

---

## What Gets Built

### Sidecar — Files Modified
- `simulation_runner.py` — complete rewrite. OASIS subprocess approach replaced with direct OASIS integration + moderator wrapper
- `persona_gen.py` — already stubbed in PRD-Simulate-D; no further changes
- `main.py` — minor update to pass `config` fields into simulation runner
- `requirements.txt` — add `camel-ai`, `oasis-sim`; remove any OASIS subprocess scaffolding
- `mirofish/` directory — remove entirely

### Sidecar — Files Created
- `moderator.py` — moderator logic: round sequencing, stagnation detection, pressure injection, specificity retry
- `oasis_adapter.py` — translates `SimulationPersona` objects into OASIS profile format; translates OASIS raw interaction log into Synapse structured log
- `round_directives.py` — all round prompt templates, indexed by round_type and simulation mode
- `Dockerfile` — Python 3.12 base image, dependency install, FastAPI server entrypoint
- `railway.toml` — Railway service configuration

### Synapse — Files Modified
- `src/hooks/useSimulate.ts` — round log state already specced in PRD-Simulate-D; wire Supabase realtime to populate it
- `.env.local` — `VITE_SIMULATE_SIDECAR_URL` updated to Railway URL post-deploy

---

## Railway Deployment

### `Dockerfile`
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "run.py"]
```

### `railway.toml`
```toml
[build]
builder = "dockerfile"

[deploy]
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

### Environment variables (set in Railway dashboard)
All existing `.env` variables migrate unchanged:
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CORS_ORIGINS`, `MAX_SIMULATION_ROUNDS`, `MAX_AGENTS`, `SIMULATION_TIMEOUT_SECONDS`

Add: `RAILWAY_ENVIRONMENT=production`

### CORS update
Add the production Synapse URL (`https://synapse-version3.vercel.app`) to `CORS_ORIGINS`.

---

## OASIS Integration — `oasis_adapter.py`

### Persona → OASIS profile translation

OASIS requires agent profiles in a structured format. The adapter translates each `SimulationPersona` into an OASIS-compatible profile:

```python
def persona_to_oasis_profile(persona: dict) -> dict:
    # Map influence_tier to OASIS activity level
    activity_map = { 'high': 0.9, 'medium': 0.6, 'low': 0.3 }
    
    # Map epistemic_style to OASIS opinion susceptibility
    susceptibility_map = {
        'empirical': 0.7,      # updates on evidence
        'ideological': 0.2,    # resistant to updating
        'opportunistic': 0.8,  # updates when beneficial
        'contrarian': 0.4,     # updates reluctantly, often reverses
        'cautious': 0.6,       # moderate updating
        'structural': 0.5      # updates on systemic arguments
    }
    
    return {
        'id': persona['agent_id'],
        'name': persona['label'],
        'type': persona['entity_type'],
        'system_prompt': persona['behavioural_prompt'],
        'activity_level': activity_map[persona['influence_tier']],
        'opinion_susceptibility': susceptibility_map[persona['epistemic_style']],
        'influence_weight': 1.0 if persona['influence_tier'] == 'high' else 0.6 if persona['influence_tier'] == 'medium' else 0.3,
        'initial_stance': persona['question_specific_stance'],
        'update_conditions': persona['update_conditions'],
        'grounding_chunks': persona['grounding_chunk_ids']
    }
```

### Inter-agent influence graph

OASIS uses a follower graph to weight whose outputs each agent is most exposed to. Build this from `SimulationPersona.inter_agent_relationships`:

- Agents with a positive relationship edge (supports, collaborates, enables) → mutual follow weight 0.8
- Agents with a negative relationship edge (blocks, contradicts, competes) → mutual follow weight 0.9 (high exposure to adversaries drives challenge dynamics)
- No relationship → default weight 0.3

### OASIS raw log → Synapse structured log

After simulation completes, transform OASIS's raw interaction history into the structured log format required by the report generator:

```python
def transform_interaction_log(oasis_log: list, personas: list) -> list:
    structured = []
    for entry in oasis_log:
        structured.append({
            'agent_id': entry['agent_id'],
            'round_number': entry['timestep'],
            'round_type': entry['round_type'],  # injected by moderator
            'prompt_issued': entry['prompt'],
            'response_text': entry['content'],
            'position_summary': extract_position_summary(entry['content']),  # one Gemini call
            'position_delta': compute_position_delta(entry['agent_id'], entry['timestep'], oasis_log),
            'confidence': entry.get('stated_confidence', 0.5),
            'agents_addressed': entry.get('reply_to', []),
            'grounding_chunks': entry.get('cited_chunks', [])
        })
    return structured
```

`extract_position_summary` is a single lightweight Gemini call (temp 0.1): "Summarise this agent's current position in one sentence." Batched across all entries after simulation completes — not called during the simulation loop.

`compute_position_delta` compares the agent's current `position_summary` to their previous round's summary. Classified as: `unchanged` / `updated` / `reversed`. Uses cosine similarity on embeddings — reversed if similarity < 0.3, updated if 0.3–0.75, unchanged if > 0.75.

---

## Round Structure — `round_directives.py`

Five round types. Each type has a base directive template and mode-specific variants.

### Round type definitions

```python
ROUND_TYPES = {
    'opening': {
        'label': 'Initial positions',
        'interaction_mode': 'broadcast',
        'directive': "Given the world context and your known position, state your assessment of the following question: {question}. Be specific. Name entities, mechanisms, and timeframes. Ground your position in the evidence you have been given."
    },
    'reaction': {
        'label': 'Response to others',
        'interaction_mode': 'directed',
        'directive': "You have read the positions of other participants. Identify the two positions you most agree or disagree with and explain why. Address those agents directly. Be specific about what in their argument you are responding to."
    },
    'challenge': {
        'label': 'Minority position advocacy',
        'interaction_mode': 'directed',
        'directive_minority': "You hold a minority position. Make your strongest case to the group. What are they missing? What evidence supports your view that they have not engaged with?",
        'directive_majority': "A minority position has been presented. Engage with it seriously. What is the strongest element of their argument? Does it cause you to revise anything?"
    },
    'revision': {
        'label': 'Position update',
        'interaction_mode': 'broadcast',
        'directive': "Has anything in this deliberation caused you to revise your position? If yes: state your updated position and exactly what argument or evidence changed your mind. If no: state what argument would have had to be made to move you, and why none of the arguments presented reached that bar."
    },
    'closing': {
        'label': 'Final falsifiable position',
        'interaction_mode': 'broadcast',
        'directive': "State your final position as a specific, falsifiable claim. Include: what you predict will happen, by when, triggered by what condition, and how someone would verify you were right or wrong. Do not hedge. If you have uncertainty, quantify it."
    }
}
```

### Round sequence by depth tier

```python
ROUND_SEQUENCES = {
    'quick_scan': ['opening', 'closing'],
    'standard': ['opening', 'reaction', 'reaction', 'revision', 'closing'],
    'deep_dive': ['opening', 'reaction', 'reaction', 'challenge', 'reaction', 'revision', 'revision', 'closing'],
    'exhaustive': ['opening', 'reaction', 'reaction', 'reaction', 'challenge', 'reaction', 'revision', 'challenge', 'revision', 'revision', 'reaction', 'closing']
}
```

### Mode-specific directive overlays

Each round directive has a mode overlay appended:

```python
MODE_OVERLAYS = {
    'prediction': "Focus on probability. What is most likely to happen?",
    'hypothesis_test': "Evaluate the hypothesis: {question}. Support or refute it with evidence.",
    'contrarian_scan': "Surface what the consensus is missing. Prioritise minority signals.",
    'optimisation': "Evaluate available paths. What course of action best serves your interests?",
    'consensus_mapping': "Find common ground. What can you agree on with others regardless of other disagreements?"
}
```

---

## Moderator Layer — `moderator.py`

The moderator runs between OASIS timesteps. It is not an OASIS agent — it is a Python wrapper that intercepts the simulation loop, evaluates state, and decides what happens next.

### Core logic

```python
class SimulationModerator:
    def __init__(self, config, personas, round_sequence):
        self.config = config
        self.personas = personas
        self.round_sequence = round_sequence
        self.current_round_index = 0
        self.stagnation_count = 0
        self.position_history = {}  # agent_id → list of position_summaries
    
    def get_current_round_directive(self) -> dict:
        round_type = self.round_sequence[self.current_round_index]
        directive = build_directive(round_type, self.config)
        return { 'round_type': round_type, 'directive': directive }
    
    def evaluate_after_round(self, round_responses: list) -> str:
        # Returns: 'advance' | 'inject_pressure' | 'end_early' | 'retry_specificity'
        
        # Check for vague responses
        vague_agents = [r for r in round_responses if is_vague(r['response_text'])]
        if vague_agents:
            return 'retry_specificity'
        
        # Check for stagnation (no position deltas)
        deltas = [r for r in round_responses if r['position_delta'] != 'unchanged']
        if len(deltas) == 0:
            self.stagnation_count += 1
        else:
            self.stagnation_count = 0
        
        if self.stagnation_count >= 2:
            # Two consecutive rounds with no movement
            if self.current_round_index < len(self.round_sequence) - 2:
                return 'inject_pressure'
            else:
                return 'end_early'
        
        return 'advance'
    
    def identify_minority_agents(self, round_responses: list) -> list:
        # Count stance_categories across current round
        stance_counts = Counter([r['stance_category'] for r in round_responses])
        majority_stances = [s for s, c in stance_counts.items() if c >= len(round_responses) * 0.6]
        minority_agents = [r['agent_id'] for r in round_responses 
                          if r['stance_category'] not in majority_stances]
        return minority_agents
    
    def inject_pressure(self, world_context: str, interaction_log: list) -> str:
        # Single LLM call — the one moment of moderator intelligence
        prompt = f"""
You are a simulation moderator. The agents in this deliberation have reached 
an unusually quick consensus. Your job is to inject a destabilising challenge.

Question being deliberated: {self.config['question']}
Current consensus position: {summarise_consensus(interaction_log)}
World context summary: {world_context[:2000]}

Generate one specific, evidence-grounded challenge that the consensus position 
has not adequately addressed. This should be a genuine weakness or overlooked 
consideration — not a generic devil's advocate position.

Return one sentence only.
"""
        response = call_gemini(prompt, temperature=0.7)
        return response.strip()
```

### Specificity check

```python
def is_vague(response_text: str) -> bool:
    # Heuristic: vague if under 50 words OR contains no named entities OR 
    # contains hedge phrases without specific claims
    word_count = len(response_text.split())
    has_named_entity = bool(re.search(r'\b[A-Z][a-z]+\b', response_text))
    hedge_only = all(phrase in response_text.lower() for phrase in 
                     ['might', 'could', 'possibly']) and word_count < 80
    return word_count < 50 or not has_named_entity or hedge_only
```

Vague responses trigger one retry with the instruction: "Your previous response was too general. Restate your position with specific named entities, a timeframe, and a concrete mechanism."

---

## Main Simulation Loop — `simulation_runner.py`

```python
async def run_simulation(job_id, seed_graph, personas, config, world_context):
    
    # 1. Translate personas to OASIS profiles
    oasis_profiles = [persona_to_oasis_profile(p) for p in personas]
    influence_graph = build_influence_graph(personas)
    
    # 2. Initialise OASIS environment
    env = OasisEnvironment(
        agents=oasis_profiles,
        influence_graph=influence_graph,
        world_context=world_context,
        platform_config={
            'broadcast_layer': True,   # for opening/revision/closing rounds
            'threaded_layer': True     # for reaction/challenge rounds
        }
    )
    
    # 3. Initialise moderator
    round_sequence = ROUND_SEQUENCES[config['depth']]
    moderator = SimulationModerator(config, personas, round_sequence)
    
    interaction_log = []
    
    # 4. Run round sequence
    for round_index, round_type in enumerate(round_sequence):
        
        # Get round directive
        round_info = moderator.get_current_round_directive()
        
        # Identify participating agents (all for opening/revision/closing; 
        # minority/majority split for challenge rounds)
        if round_type == 'challenge':
            minority_ids = moderator.identify_minority_agents(
                [e for e in interaction_log if e['round_number'] == round_index - 1]
            )
            participating_agents = oasis_profiles  # all participate but with split directives
        else:
            participating_agents = oasis_profiles
        
        # Issue round to OASIS — batched at 5 concurrent calls
        round_responses = await env.run_timestep(
            round_type=round_type,
            directive=round_info['directive'],
            minority_agent_ids=minority_ids if round_type == 'challenge' else [],
            interaction_mode=ROUND_TYPES[round_type]['interaction_mode'],
            max_response_words=150
        )
        
        # Moderator evaluation
        action = moderator.evaluate_after_round(round_responses)
        
        if action == 'retry_specificity':
            vague_agents = [r for r in round_responses if is_vague(r['response_text'])]
            for agent in vague_agents:
                retry_response = await env.retry_agent(
                    agent_id=agent['agent_id'],
                    retry_prompt="Your previous response was too general. Restate with specific named entities, a timeframe, and a concrete mechanism."
                )
                # Replace vague response with retry
                round_responses = [retry_response if r['agent_id'] == agent['agent_id'] 
                                   else r for r in round_responses]
        
        elif action == 'inject_pressure':
            pressure = moderator.inject_pressure(world_context, interaction_log)
            # Inject as a system message visible to all agents in next round
            env.inject_event(f"Moderator challenge: {pressure}")
        
        elif action == 'end_early':
            update_job_status(job_id, 'simulation_stagnated', 
                            note='Simulation ended early — consensus reached with no further movement.')
            break
        
        # Log round
        interaction_log.extend(round_responses)
        moderator.current_round_index += 1
        
        # Write progress to Supabase (fire-and-forget)
        update_round_progress(job_id, round_index + 1, len(round_sequence), round_type, 
                             delta_count=len([r for r in round_responses 
                                           if r.get('position_delta') != 'unchanged']))
    
    # 5. Transform OASIS log to Synapse structured log
    structured_log = transform_interaction_log(interaction_log, personas)
    
    return structured_log
```

---

## Supabase Progress Writes

After each round completes, write a progress update (fire-and-forget daemon thread — existing pattern from `SIMULATE-FEATURE.md`):

```python
def update_round_progress(job_id, current_round, total_rounds, round_type, delta_count):
    def _write():
        supabase.table('simulation_jobs').update({
            'progress': {
                'current_round': current_round,
                'total_rounds': total_rounds,
                'round_type': round_type,
                'delta_count': delta_count,
                'pct': round((current_round / total_rounds) * 100)
            },
            'status': 'running'
        }).eq('id', job_id).execute()
    
    thread = threading.Thread(target=_write, daemon=True)
    thread.start()
```

### Frontend activity feed (wires into PRD-Simulate-D's `roundLog` state)

Supabase realtime subscription in `useSimulate.ts` already watches `simulation_jobs`. Extend the handler:

```typescript
if (payload.new.progress) {
  const { current_round, round_type, delta_count } = payload.new.progress;
  const label = ROUND_TYPE_LABELS[round_type];
  const note = delta_count > 0 
    ? `${delta_count} agent${delta_count > 1 ? 's' : ''} revised their position`
    : 'Positions held';
  
  setRoundLog(prev => [...prev, { 
    round: current_round, 
    label, 
    note,
    updatedAgentCount: delta_count 
  }]);
}
```

`ROUND_TYPE_LABELS` maps round_type strings to user-facing labels:
- opening → "Initial positions established"
- reaction → "Agents responding to each other"
- challenge → "Minority position presented"
- revision → "Position revision round"
- closing → "Final positions locked"

---

## Interaction Log Schema (output of this layer, input to PRD-Simulate-F)

```typescript
interface InteractionLogEntry {
  agent_id: string;
  agent_label: string;
  round_number: number;
  round_type: 'opening' | 'reaction' | 'challenge' | 'revision' | 'closing';
  prompt_issued: string;
  response_text: string;
  position_summary: string;        // one sentence, extracted post-simulation
  position_delta: 'unchanged' | 'updated' | 'reversed';
  confidence: number;              // 0–1
  agents_addressed: string[];      // agent_ids addressed in directed rounds
  grounding_chunks: string[];      // chunk_ids cited in response
  stance_category: StanceCategory; // current stance after this round
}
```

This log is stored as `simulation_jobs.interaction_log` (JSONB). It is the complete provenance record — every claim in the report traces back to entries in this log.

```sql
ALTER TABLE simulation_jobs
ADD COLUMN interaction_log JSONB;
```

---

## MiroFish Removal

- Delete `mirofish/` directory entirely
- Remove from `requirements.txt`: any MiroFish-specific packages, Flask, Neo4j driver
- Remove from `main.py`: any MiroFish import references
- The only OASIS-related packages retained are `camel-ai` and `oasis-sim`

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| OASIS subprocess fails on first run | Log full error to `simulation_jobs.error`. Fall back to direct Gemini synthesis (existing fallback path) — do not mark job as failed. Note fallback in report header. |
| Single agent in scope | Skip challenge rounds entirely (no minority possible). Reduce to opening → reaction → revision → closing. |
| All agents converge in round 1 | Moderator detects stagnation_count = 0 but zero deltas in round 2. Injects pressure event. If still no movement after round 3, end early with note. |
| Gemini rate limit hit during round | Exponential backoff: 2s → 4s → 8s → 16s. After 4 retries, mark that agent's round response as `{ response_text: '[rate limit — no response]', position_delta: 'unchanged' }`. Do not fail the simulation. |
| Railway service cold start during simulation | FastAPI health check endpoint returns 503 until ready. Synapse trigger function retries POST up to 3 times with 5s delay before marking job as failed. |
| Simulation exceeds SIMULATION_TIMEOUT_SECONDS | Mark job status as `timeout`. Store partial interaction_log. Report generator attempts partial report from available rounds, labelled as incomplete. |

---

## Acceptance Criteria

- Python 3.12 sidecar deploys successfully to Railway with all dependencies installed including `camel-ai` and `oasis-sim`
- OASIS runs a full simulation without falling back to the Gemini-direct path
- Round sequence matches the depth tier: quick_scan = 2 rounds, standard = 5, deep_dive = 8, exhaustive = 12
- Each round type issues the correct directive template with mode overlay applied
- Challenge rounds correctly identify minority-position agents and issue split directives
- Moderator detects stagnation after 2 consecutive zero-delta rounds and injects pressure via one LLM call
- Vague agent responses trigger one retry before being accepted
- Progress writes fire after each round and the frontend activity feed updates in real time
- Activity feed labels map correctly to round types with delta counts
- Interaction log is written to `simulation_jobs.interaction_log` on completion
- Every interaction log entry has: agent_id, round_number, round_type, response_text, position_summary, position_delta, stance_category
- `mirofish/` directory is fully removed and no MiroFish imports remain
- Existing Quick Scan simulations complete within Railway's free tier memory limits
- Partial interaction log is stored on timeout — job is not lost
