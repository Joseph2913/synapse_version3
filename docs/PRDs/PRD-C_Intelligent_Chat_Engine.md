# PRD-C — Intelligent Chat Conversation Engine

**Phase:** Intelligence (post-Phase 3)
**Dependencies:** PRD-A (Chat Entry Context System), PRD-B (Context-Aware Entry Points)
**Estimated complexity:** High
**Depends on:** `ChatEntryContext`, scoped RAG pipeline, system directive injection, entry-point routing — all from PRD-A/B

---

## 1. Objective

Make the Ask view's conversation engine intelligent enough to adapt its behaviour to every query without manual configuration. The model should detect what kind of question is being asked, select the right retrieval strategy, structure its response appropriately for the query type, allocate deeper reasoning for complex questions, and suggest natural follow-up questions that keep the conversation productive.

Today, every query runs the same pipeline with the same system prompt and produces the same prose format. The user must manually select a mindset, tool mode, and model tier from the toolbar. After this PRD, the system auto-classifies query intent, adapts its response structure per query type, uses thinking budgets proportional to complexity, and generates follow-up suggestions — while upgrading from the soon-to-be-retired Gemini 2.0 Flash to Gemini 2.5 Flash.

---

## 2. What Gets Built

### 2.1 Model Upgrade: Gemini 2.0 Flash → 2.5 Flash

**Why:** Gemini 2.0 Flash is being retired June 1, 2026. Gemini 2.5 Flash is a drop-in replacement with the same API shape, same JSON mode, same endpoint pattern — but adds hybrid reasoning with configurable thinking budgets.

**Modified file: `src/services/gemini.ts`**

Replace all instances of `gemini-2.0-flash` with `gemini-2.5-flash`:

- Line 144: extraction endpoint
- Line 409: query decomposition endpoint
- Line 476: RAG generation endpoint

**Modified file: `src/config/queryMindsets.ts`**

Update `MODEL_TIERS` to reference `gemini-2.5-flash`:

```typescript
export const MODEL_TIERS: ModelTier[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'Quick responses, minimal reasoning',
    icon: 'Rabbit',
    generationConfig: {
      model: 'gemini-2.5-flash',
      maxOutputTokens: 1024,
      temperature: 0.2,
    },
  },
  {
    id: 'thorough',
    label: 'Thorough',
    description: 'Deeper analysis, extended reasoning',
    icon: 'Brain',
    generationConfig: {
      model: 'gemini-2.5-flash',
      maxOutputTokens: 4096,
      temperature: 0.3,
    },
  },
]
```

**No API key changes needed** — the same Gemini API key works for all model versions.

### 2.2 Auto-Classification Pre-Pass

**New file: `src/services/queryClassifier.ts`**

A lightweight classification call that runs before the full RAG pipeline. Takes the user's question (and optional entry context) and returns a structured intent classification.

```typescript
export interface QueryClassification {
  /** Detected intent type */
  intent: 'factual' | 'analytical' | 'comparative' | 'exploratory' | 'temporal' | 'actionable'

  /** Recommended retrieval strategy */
  retrieval: {
    chunkCount: number         // How many source chunks to fetch (3–20)
    traversalHops: number      // Graph traversal depth (1–3)
    prioritiseRecency: boolean // Weight recent sources higher
    needsBroadSearch: boolean  // Skip scope locks, search widely
  }

  /** Recommended response format */
  responseFormat: 'prose' | 'list' | 'comparison' | 'timeline' | 'summary'

  /** Thinking budget for Gemini 2.5 Flash (0 = no thinking, higher = deeper reasoning) */
  thinkingBudget: number  // 0, 1024, 4096, 8192

  /** Whether to suggest a follow-up question */
  suggestFollowUp: boolean

  /** Confidence in the classification (0–1) */
  confidence: number
}

/**
 * Classify query intent using a fast Gemini 2.5 Flash call (~200ms).
 * For entry-point queries (PRD-B), the classification is pre-determined
 * by the entry context and this function is skipped.
 */
export async function classifyQuery(
  question: string,
  conversationContext?: string
): Promise<QueryClassification>
```

**Implementation:**

The classifier sends a single compact prompt to `gemini-2.5-flash` with `maxOutputTokens: 256`, `temperature: 0`, and `responseMimeType: 'application/json'`:

```
Classify this knowledge graph query. Return ONLY valid JSON.

Query: "{question}"
{conversationContext ? `Conversation context: "${conversationContext}"` : ''}

Classify into:
- intent: factual (specific fact/date/name), analytical (why/how/implications), comparative (X vs Y), exploratory (open-ended/what exists), temporal (timeline/evolution/latest), actionable (risks/actions/decisions)
- retrieval: { chunkCount (3-20), traversalHops (1-3), prioritiseRecency (bool), needsBroadSearch (bool) }
- responseFormat: prose (default analysis), list (ranked items), comparison (structured side-by-side), timeline (chronological), summary (concise overview)
- thinkingBudget: 0 (simple fact), 1024 (moderate), 4096 (complex analysis), 8192 (deep multi-source reasoning)
- suggestFollowUp: true if the topic has natural depth to explore further
- confidence: 0-1

Return only the JSON object.
```

**Fallback:** If classification fails (timeout, parse error), return a default classification: `{ intent: 'analytical', retrieval: { chunkCount: 15, traversalHops: 2, prioritiseRecency: false, needsBroadSearch: false }, responseFormat: 'prose', thinkingBudget: 1024, suggestFollowUp: true, confidence: 0 }`.

**When classification is skipped:** When a `ChatEntryContext` from PRD-B is present with `queryConfigOverrides` and a `systemDirective`, the intent is already known. The auto-classifier is bypassed, and the pipeline uses the entry context's settings directly. Classification only runs for free-typed questions and follow-up messages where the entry context doesn't dictate the query type.

### 2.3 Thinking Budgets

**Modified file: `src/services/gemini.ts`**

Add `thinkingConfig` to the `generateRAGResponse` function's Gemini API call:

```typescript
body: JSON.stringify({
  system_instruction: { parts: [{ text: systemPrompt }] },
  contents,
  generationConfig: {
    temperature: temperatureOverride ?? 0.3,
    maxOutputTokens: maxOutputTokens ?? 4096,
    responseMimeType: 'application/json',
    // NEW: thinking budget from classification
    ...(thinkingBudget > 0 ? { thinkingConfig: { thinkingBudget } } : {}),
  },
})
```

The `thinkingBudget` parameter is passed through from `queryGraph` based on either:
- The auto-classifier's recommendation (for free-typed queries)
- A per-entry-point default (for PRD-B redirects):

| Entry Point | Default Thinking Budget |
|---|---|
| Chat with source | 1024 (focused, single doc) |
| Compare sources | 8192 (complex multi-source reasoning) |
| Explore with AI | 4096 (broad synthesis) |
| Find Similar | 0 (structural query, not reasoning-heavy) |
| Chat about relationship | 1024 (focused, two entities) |
| Source × Anchor | 4096 (cross-reference reasoning) |
| Post-extraction | 4096 (synthesis of new content) |
| Digest drilldown | 8192 (deep expansion of briefing) |
| Anchor explore | 4096 (hub analysis) |
| Free-typed (auto) | Per classifier output |

**Modified file: `src/services/rag.ts`**

Add `thinkingBudget` as a pass-through parameter in `queryGraph`:

```typescript
export async function queryGraph(
  question: string,
  userId: string,
  conversationHistory: { role: string; content: string }[],
  queryConfig?: QueryConfig,
  onStepChange?: (event: RAGStepEvent) => void,
  signal?: AbortSignal
): Promise<RAGResponse>
```

No signature change — `QueryConfig` gains an optional `thinkingBudget?: number` field.

### 2.4 Per-Query-Type Response Formatting

**Modified file: `src/services/gemini.ts`**

The system directive from PRD-B already tells the model *what* to focus on. This PRD adds **response format instructions** that tell the model *how* to structure the output. These are injected into the system prompt alongside the directive.

**New file: `src/config/responseFormats.ts`**

```typescript
export const RESPONSE_FORMATS: Record<string, string> = {

  source_chat: `## Response Structure
Organise your response by themes found in this source (2–4 themes). For each theme, use a **bold heading** and provide specific quotes, data points, decisions, and names — the detail that a summary strips out. End with a brief "Connections to your graph" section (2–3 sentences) linking this source's themes to entities in other sources. Do not include an introductory preamble — dive straight into the first theme.`,

  source_compare: `## Response Structure
Open with one sentence framing what these two sources have in common. Then organise by shared themes (2–3). For each theme, use a **bold heading** followed by two clearly attributed paragraphs: "In **{Source A title}**..." and "In **{Source B title}**...". After the themes, add a **"Unique to each"** section noting what one source covers that the other does not. Close with a **"Synthesis"** paragraph: "Together, these sources tell you..." Keep attribution clear throughout — never blend which source said what.`,

  entity_explore: `## Response Structure
Lead with what this entity is and why it matters — one strong paragraph. Then cover **Key Relationships** (the 3–5 most significant connections, each as a short paragraph). Then **Across Sources** (where this entity appears and whether it means different things in different contexts). End with **Open Threads** (anything unresolved, contradicted, or worth exploring further).`,

  entity_similar: `## Response Structure
Brief intro: "Based on {entity}'s profile, here are the most related entities in your graph." Then a **numbered list** (5–8 items). Each item: **bold label** (Entity Type), then 1–2 sentences explaining *why* it is similar (shared sources, shared connections, semantic overlap, same tags). End with one **"Surprise connection"** — a non-obvious match with a brief explanation of why it is unexpected.`,

  relationship_chat: `## Response Structure
Do not restate the relationship — the user can see it. Start with **Evidence**: what source material supports this connection, with specific quotes or details. Then **Implications**: what this relationship enables, risks, or means for the broader picture. Then **Cross-Source Perspective**: if different sources have different takes on this relationship, surface that. Keep the response focused and shorter than a typical answer — this is a targeted question.`,

  source_anchor: `## Response Structure
Lead with one sentence on the anchor's significance. Then **What this source contributes**: 2–3 specific things this source adds to the user's understanding of the anchor topic. Then **Compared to other sources**: what other anchor-connected sources say, and whether this source agrees, extends, or challenges them. Then **Bridge entities**: which extracted entities from this source link to the anchor and through what relationships. Frame the overall answer as: "Here is what this source contributes to your understanding of {anchor}."`,

  post_extraction: `## Response Structure
Start with **What you captured**: the 3–5 most substantive entities with their types and brief descriptions. Then **Key relationships**: the most interesting connections that were extracted. Then **Cross-connections**: how this new content links to existing knowledge (this is the high-value moment). End with **What might be missing**: a gentle suggestion of what the extraction may have overlooked. Use a conversational, warm tone — this is a moment of satisfaction.`,

  digest_drilldown: `## Response Structure
Do not repeat the executive summary. Expand on the 2–3 biggest themes: for each, give the full story — what sources support it, what entities are involved, what the nuance is. Then **Connections the digest missed**: cross-connections between themes that the briefing did not surface. End with **Open questions**: things the digest flagged but did not resolve.`,

  anchor_explore: `## Response Structure
Start with a **Hub summary**: what this anchor represents and how central it is. Then **Top connected entities** (5–8), grouped by type (People, Projects, Decisions, etc.). Then **Source coverage**: which sources feed into this anchor and what each contributes. End with **Trajectory**: is this anchor gaining new connections over time or static?`,

  auto_prose: `## Response Structure
Write in clear flowing prose. Use **bold** for people's names, key terms, and important facts. Use natural paragraph breaks. Lead with the most important finding, then supporting evidence, then implications or open questions.`,

  auto_list: `## Response Structure
Brief intro (1–2 sentences), then a **numbered list** with each item as a bold label followed by 1–2 sentences of explanation. End with a brief synthesis.`,

  auto_comparison: `## Response Structure
Organise the response as a structured comparison along consistent dimensions. For each dimension, cite the specific evidence supporting each side. End with a synthesis noting the most significant differences or similarities.`,

  auto_timeline: `## Response Structure
Organise chronologically, oldest to most recent. Each entry: **bold date/period**, then what happened and why it matters. End with a "Current state" paragraph and a forward-looking observation.`,

  auto_summary: `## Response Structure
Provide a concise overview in 3–5 paragraphs. Lead with the core answer, follow with key supporting details, end with context or caveats. Keep it shorter than a typical analytical response.`,
}
```

**How formats are selected:**

For PRD-B entry points, the format is determined by the entry point type:

| Entry Point | Format Key |
|---|---|
| `home_source_chat` | `source_chat` |
| `home_source_compare` | `source_compare` |
| `home_entity_explore`, `explore_entity_browse`, `explore_entity_graph`, `anchors_explore` | `entity_explore` |
| `home_entity_similar` | `entity_similar` |
| `home_relationship_chat` | `relationship_chat` |
| `home_source_anchor` | `source_anchor` |
| `capture_post_extraction` | `post_extraction` |
| `pipeline_extraction_detail` | `source_chat` |
| `orient_digest_drilldown` | `digest_drilldown` |

For free-typed queries, the format is determined by the auto-classifier's `responseFormat` field:

| Classifier Output | Format Key |
|---|---|
| `prose` | `auto_prose` |
| `list` | `auto_list` |
| `comparison` | `auto_comparison` |
| `timeline` | `auto_timeline` |
| `summary` | `auto_summary` |

**Injection point:** The response format string is appended to the system prompt after the system directive (PRD-A) and before the source chunks. Order in the system prompt becomes:

1. Core mission block
2. System directive (PRD-A — entry-point-specific instruction)
3. Response format instruction (this PRD — structural guidance)
4. Answering rules
5. Mindset prompt addition
6. Source chunks, entity summaries, relationship paths

### 2.5 Follow-Up Question Generation

**Modified JSON output schema:**

The Gemini response JSON gains an optional `followUp` field:

```json
{
  "answer": "...",
  "citations": [...],
  "followUp": {
    "question": "What risks are associated with Project Alpha?",
    "label": "Explore risks"
  }
}
```

**System prompt addition** (appended to the response format instructions):

```
FOLLOW-UP QUESTION:
When the topic has natural depth to explore further, include a "followUp" object in your JSON response with a "question" (a natural next question the user might ask, phrased as the user would phrase it) and a "label" (2–4 word button label). The follow-up should deepen the current thread, not change topics. Omit the followUp object for simple factual answers that don't warrant further exploration.
```

**Modified file: `src/types/rag.ts`**

Add `followUp` to `ChatMessage`:

```typescript
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations?: InlineCitation[]
  timestamp: Date
  pipelineDurationMs?: number
  followUp?: {                    // NEW
    question: string
    label: string
  }
}
```

Add `followUp` to `RAGGenerationResult`:

```typescript
export interface RAGGenerationResult {
  answer: string
  citations: InlineCitation[]
  followUp?: {                    // NEW
    question: string
    label: string
  }
}
```

**Modified file: `src/services/gemini.ts` → `parseRAGResponse`**

Parse the `followUp` field from the Gemini JSON response:

```typescript
const followUp = parsed.followUp && typeof parsed.followUp === 'object'
  ? {
      question: typeof parsed.followUp.question === 'string' ? parsed.followUp.question : '',
      label: typeof parsed.followUp.label === 'string' ? parsed.followUp.label : 'Go deeper',
    }
  : undefined
return { answer, citations, followUp }
```

**Modified file: `src/hooks/useRAGQuery.ts`**

Pass `followUp` from the generation result through to the `ChatMessage`:

```typescript
const assistantMessage: ChatMessage = {
  id: generateId(),
  role: 'assistant',
  content: response.answer,
  citations: response.citations,
  timestamp: new Date(),
  pipelineDurationMs,
  followUp: response.followUp,     // NEW
}
```

### 2.6 Follow-Up Suggestion Pill (UI)

**Modified file: `src/components/ask/ChatMessage.tsx`**

After the message content, render a follow-up suggestion pill if `message.followUp` exists:

```tsx
{!isUser && message.followUp && (
  <button
    type="button"
    onClick={() => onFollowUpClick?.(message.followUp!.question)}
    className="font-body font-semibold cursor-pointer"
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 10,
      padding: '7px 14px',
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--color-accent-500)',
      background: 'var(--color-accent-50)',
      border: '1px solid rgba(214,58,0,0.15)',
      transition: 'background 0.15s ease, border-color 0.15s ease',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = 'rgba(214,58,0,0.1)'
      e.currentTarget.style.borderColor = 'rgba(214,58,0,0.25)'
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'var(--color-accent-50)'
      e.currentTarget.style.borderColor = 'rgba(214,58,0,0.15)'
    }}
  >
    {message.followUp.label} →
  </button>
)}
```

**New prop on `ChatMessage`:**

```typescript
interface ChatMessageProps {
  message: ChatMessageType
  onCitationClick?: (index: number) => void
  onFollowUpClick?: (question: string) => void   // NEW
}
```

**Modified file: `src/components/ask/ChatMessageList.tsx`**

Pass `onFollowUpClick` through:

```typescript
<ChatMessage
  key={message.id}
  message={message}
  onCitationClick={onCitationClick}
  onFollowUpClick={onFollowUpClick}
/>
```

**Modified file: `src/views/AskView.tsx`**

Wire the follow-up handler — clicking the pill sends the follow-up question through the same `handleSend` path, inheriting the active entry context (scope, directive):

```typescript
const handleFollowUp = (question: string) => {
  void sendMessage(question, config)
}
```

Pass to `ChatMessageList`:

```tsx
<ChatMessageList
  messages={messages}
  isLoading={isLoading}
  pipelineEvents={pipelineEvents}
  scroll={scroll}
  onFollowUpClick={handleFollowUp}
/>
```

### 2.7 Toolbar: Auto Mode Default

**Modified file: `src/config/queryMindsets.ts`**

Add "Auto" as the first mindset:

```typescript
{
  id: 'auto',
  label: 'Auto',
  description: 'Synapse detects the query type and adapts automatically. Best for most questions.',
  icon: 'Sparkles',
  color: '#6b7280',
  promptAddition: '',  // No static prompt — handled by classifier
  temperatureOverride: undefined,  // Determined by classifier
}
```

**Modified file: `src/types/rag.ts`**

Extend the mindset union type:

```typescript
export type QueryMindsetId = 'auto' | 'factual' | 'analytical' | 'comparative' | 'exploratory'
```

Update default:

```typescript
export const DEFAULT_QUERY_CONFIG: QueryConfig = {
  mindset: 'auto',          // CHANGED from 'analytical'
  scopeAnchors: [],
  toolMode: 'deep',
  modelTier: 'thorough',
}
```

**Modified file: `src/services/rag.ts`**

When `mindset === 'auto'`, the pipeline:
1. Runs the classifier (`classifyQuery`) before retrieval
2. Uses the classifier's `retrieval` output to set chunk counts and traversal depth
3. Uses the classifier's `thinkingBudget` for the generation call
4. Uses the classifier's `responseFormat` to select the response format string from `responseFormats.ts`
5. Maps the classifier's `intent` to the closest existing mindset for the `promptAddition` (factual→factual, analytical→analytical, comparative→comparative, exploratory/temporal/actionable→exploratory)

When mindset is manually set (not 'auto'), the classifier is skipped and the pipeline behaves exactly as today plus the thinking budget defaults from the manual selection.

### 2.8 RAG Pipeline Integration

**Modified file: `src/services/rag.ts`**

The updated `queryGraph` flow becomes:

```
1. Resolve query config (mindset, tool mode, model tier, scope)
2. IF mindset === 'auto' AND no entry-point override:
     Run classifyQuery(question) → QueryClassification
     Apply classification to pipeline parameters
   ELSE:
     Use config as-is (entry-point or manual selection)
3. Query decomposition + embedding (existing — parallel)
4. Hybrid retrieval (existing — with scope constraints from PRD-A)
   - chunk count, traversal hops from classifier or config
5. Reranking + source balancing (existing)
6. Graph traversal (existing — with scope seeds from PRD-A)
7. Context assembly (existing)
8. Select response format string from responseFormats.ts
9. Build system prompt: mission + directive + format + rules + mindset + chunks
10. Generate with thinking budget
11. Parse response including followUp field
12. Resolve citations
13. Return
```

Step 2, 8, and 10 are the new additions. The rest of the pipeline is unchanged.

---

## 3. Design Requirements

### Follow-Up Suggestion Pill

- **Position:** Below the assistant message content, left-aligned, with 10px top margin
- **Shape:** Pill (20px border-radius)
- **Background:** `var(--color-accent-50)` → hover: `rgba(214,58,0,0.1)`
- **Border:** `1px solid rgba(214,58,0,0.15)` → hover: `rgba(214,58,0,0.25)`
- **Text:** DM Sans, 12px, weight 600, `var(--color-accent-500)`
- **Content:** `{label} →` (arrow suffix)
- **Animation:** Fade in with the message (inherits existing `msg-enter` animation)
- **Only shown on the most recent assistant message** — previous messages' pills are hidden to avoid clutter. When a new message arrives, the previous pill disappears.

### Auto Mode Indicator in Toolbar

- The "Auto" mindset pill in the toolbar uses a `Sparkles` icon (matching the Synapse assistant indicator)
- When Auto mode is active and a query is in-flight, the pill briefly shows a subtle shimmer animation (0.8s ease, once) to indicate classification is happening
- The toolbar still shows the other manual mindsets (Factual, Analytical, Comparative, Exploratory) — selecting any of them switches off Auto for that session until the user switches back

### Response Format Visual Differences

The response text itself uses the same `ChatMessage` component and the same markdown parsing (`**bold**`, inline citations, code ticks, line breaks). The structural differences come from the content the model generates, not from different rendering logic. However, two visual enhancements support the per-format structures:

**Numbered list items:** The existing markdown parser handles `**1.** Item text` patterns through the bold parsing. No new parsing needed — the model generates the structure in its text output.

**Section headings within messages:** When the model generates `**Key Relationships**` or `**Evidence**` as section headings within a response, they render as bold text through the existing `**bold**` parser. This is sufficient — the sections are visually distinct without needing actual heading elements inside a chat bubble.

---

## 4. Data & Service Layer

### New Service Functions

| Function | File | Purpose |
|---|---|---|
| `classifyQuery` | `queryClassifier.ts` | Lightweight Gemini 2.5 Flash call to classify query intent and recommend retrieval strategy |

### Modified Service Functions

| Function | File | Change |
|---|---|---|
| `generateRAGResponse` | `gemini.ts` | Add `thinkingBudget` and `responseFormat` params, inject format into system prompt, pass thinking config to API |
| `buildRAGSystemPrompt` | `gemini.ts` | Accept `responseFormatInstruction` parameter, inject between directive and answering rules |
| `parseRAGResponse` | `gemini.ts` | Parse `followUp` field from JSON response |
| `queryGraph` | `rag.ts` | Run classifier when mindset is 'auto', apply classification to pipeline params, pass thinking budget and response format through |

### New Config

| File | Content |
|---|---|
| `src/config/responseFormats.ts` | Response format instruction strings per entry point and auto-classified type |

### Modified Types

| Type | File | Change |
|---|---|---|
| `QueryMindsetId` | `rag.ts` | Add `'auto'` to union |
| `QueryConfig` | `rag.ts` | Add optional `thinkingBudget?: number`, `responseFormat?: string` |
| `ChatMessage` | `rag.ts` | Add optional `followUp?: { question: string; label: string }` |
| `RAGGenerationResult` | `rag.ts` | Add optional `followUp` field |
| `DEFAULT_QUERY_CONFIG` | `rag.ts` | Change default mindset from `'analytical'` to `'auto'` |

---

## 5. Interaction & State

### Free-Typed Query (Auto Mode)

1. User types a question, presses Enter
2. If mindset is 'auto': classifier runs (~200ms), returns `QueryClassification`
3. Pipeline uses classification's `retrieval` settings (chunk count, traversal hops, recency priority)
4. System prompt includes the auto-selected response format
5. Generation uses the classification's `thinkingBudget`
6. Response includes a `followUp` if the classifier flagged `suggestFollowUp: true`
7. User sees the response with a follow-up pill at the bottom
8. Clicking the pill sends the follow-up question through the same pipeline, inheriting scope/directive from entry context

### Entry-Point Query (PRD-B)

1. User arrives via a redirect (e.g., "Chat with source")
2. Classifier is **skipped** — intent is known from the entry context
3. Response format is selected by entry point type (e.g., `source_chat`)
4. Thinking budget uses the per-entry-point default table (Section 2.3)
5. Follow-up generation is always enabled for entry-point queries
6. Follow-up is scoped to the entry context (same source, same entity, etc.)

### Manual Override

1. User clicks a specific mindset in the toolbar (e.g., "Factual")
2. Auto mode is deactivated — classifier is skipped for all subsequent queries
3. Pipeline uses the manually selected mindset's `promptAddition` and `temperatureOverride`
4. Response format defaults to `auto_prose` (manual mindsets don't auto-select format)
5. Thinking budget defaults to 1024 for manual mindsets
6. User can switch back to Auto at any time

### Follow-Up Pill Behaviour

1. Only the **most recent** assistant message shows a follow-up pill
2. When a new message is sent (user or assistant), the previous pill disappears
3. Clicking the pill sends the question as a normal user message
4. The follow-up inherits the active entry context (scope, directive)
5. The follow-up's response may generate its own follow-up pill (recursive chain)

---

## 6. Forward-Compatible Decisions

- **Classifier output is extensible.** Future PRDs can add fields to `QueryClassification` (e.g., `targetEntityType`, `temporalRange`, `complexityScore`) without breaking existing code. The classifier prompt can be updated independently.

- **Response formats are config-driven.** Adding a new format (e.g., for a future "Decision Log" entry point) means adding one string to `responseFormats.ts`. No code changes in the pipeline.

- **Thinking budgets are per-request.** Future PRDs could let power users control their own thinking budget via the toolbar (a "Reasoning depth" slider), building on the infrastructure here.

- **The classifier is a natural hook for analytics.** The `QueryClassification` output (intent, confidence, thinking budget) can be logged to understand how users query their graph. This data informs future UX decisions.

- **PRD-D (right panel + citations + history) will use `followUp` data** to pre-populate suggestion chips in the right panel. The data structure is designed to support that without modification.

- **Model swappability.** The model string is referenced in exactly 4 places (3 in gemini.ts, 1 in queryMindsets.ts). If Google releases Gemini 3 Flash stable, upgrading is a 4-line change. If you later want to route specific query types to Claude (e.g., deep analytical queries to Sonnet), the classifier output provides the routing signal.

---

## 7. Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Classifier call fails (timeout, API error, parse error) | Fall back to default classification: analytical intent, prose format, 1024 thinking budget. Log warning. Pipeline continues normally. |
| Classifier returns invalid JSON | Same fallback as above. |
| Classifier returns unknown intent value | Map to `analytical` (safest default). |
| Classifier returns 0 thinking budget for a complex query | Accept it — 0 budget still produces a response, just without internal reasoning. The model may produce a shorter answer. |
| `followUp` field is missing from Gemini response | `parseRAGResponse` returns `undefined` for followUp. No pill rendered. This is expected for simple factual queries. |
| `followUp.question` is empty string | Treat as no follow-up (don't render pill). |
| User clicks follow-up pill while a query is already in-flight | Ignore the click (button is disabled during loading, matching send button behaviour). |
| Gemini 2.5 Flash doesn't support `thinkingConfig` in JSON mode | If the API rejects the parameter, retry without it. Log warning. Thinking budgets gracefully degrade to no-thinking mode. |
| Auto mode selected but entry context provides queryConfigOverrides | Entry context overrides take precedence. Classifier is skipped. |
| User switches from Auto to manual mid-conversation | Manual mindset applies to the next query only. Previous responses retain their original formatting. |

---

## 8. Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `src/services/queryClassifier.ts` | Query intent classification service |
| `src/config/responseFormats.ts` | Per-entry-point and per-intent response format instruction strings |

### Modified Files

| File | Change |
|---|---|
| `src/services/gemini.ts` | Upgrade model to `gemini-2.5-flash`, add `thinkingBudget`/`responseFormat` params to `generateRAGResponse` and `buildRAGSystemPrompt`, parse `followUp` in `parseRAGResponse` |
| `src/services/rag.ts` | Integrate classifier when mindset is 'auto', pass thinking budget and response format through pipeline, apply classifier retrieval overrides |
| `src/config/queryMindsets.ts` | Add 'Auto' mindset, update `MODEL_TIERS` model strings to `gemini-2.5-flash` |
| `src/types/rag.ts` | Add `'auto'` to `QueryMindsetId`, add `thinkingBudget`/`responseFormat` to `QueryConfig`, add `followUp` to `ChatMessage` and `RAGGenerationResult`, change default mindset |
| `src/components/ask/ChatMessage.tsx` | Render follow-up pill, add `onFollowUpClick` prop |
| `src/components/ask/ChatMessageList.tsx` | Pass `onFollowUpClick` through to `ChatMessage` |
| `src/views/AskView.tsx` | Wire `handleFollowUp` handler, pass to `ChatMessageList` |
| `src/components/ask/InlineQueryToolbar.tsx` | Add Auto option to mindset dropdown, add Sparkles icon |

---

## 9. Acceptance Criteria

**Model upgrade:**
- [ ] All Gemini API calls in `gemini.ts` reference `gemini-2.5-flash` (zero references to `gemini-2.0-flash` remain)
- [ ] All `MODEL_TIERS` in `queryMindsets.ts` reference `gemini-2.5-flash`
- [ ] Extraction, query decomposition, embedding, and RAG generation all work with the new model
- [ ] No regressions in response quality for existing query patterns

**Auto-classification:**
- [ ] When mindset is 'auto' and no entry context is present, the classifier runs before the RAG pipeline
- [ ] The classifier returns valid `QueryClassification` JSON
- [ ] The classifier's retrieval recommendations (chunk count, traversal hops) are applied to the pipeline
- [ ] If classification fails, the pipeline falls back to default settings and still produces a response
- [ ] For entry-point queries (PRD-B), the classifier is skipped

**Thinking budgets:**
- [ ] `thinkingConfig` is passed to the Gemini API when `thinkingBudget > 0`
- [ ] Entry-point queries use their per-entry-point default thinking budget
- [ ] Auto-classified queries use the classifier's recommended thinking budget
- [ ] Manual mindset queries default to 1024 thinking budget

**Response formatting:**
- [ ] Entry-point queries produce responses structured according to their format spec (e.g., source_compare produces attributed two-source comparison structure)
- [ ] Auto-classified queries produce responses matching the detected format (list, comparison, timeline, etc.)
- [ ] "Find Similar" produces a numbered list, not prose
- [ ] "Compare sources" produces attributed side-by-side analysis, not blended prose
- [ ] "Chat with source" produces theme-based deep-dive, not a summary

**Follow-up suggestions:**
- [ ] Assistant messages include a follow-up pill when the model returns a `followUp` object
- [ ] Only the most recent assistant message shows a pill
- [ ] Clicking the pill sends the question as a normal message, inheriting active entry context
- [ ] Simple factual responses do not show a follow-up pill
- [ ] The pill matches the design spec (accent-50 background, pill shape, DM Sans 12/600)

**Toolbar:**
- [ ] Default mindset is 'Auto' (not 'Analytical')
- [ ] The Auto option appears in the mindset dropdown with a Sparkles icon
- [ ] Selecting a manual mindset disables auto-classification for subsequent queries
- [ ] Selecting Auto re-enables auto-classification

**No regressions:**
- [ ] All existing entry-point redirects (PRD-B) still work
- [ ] All existing toolbar controls (tool mode, model tier, scope anchors) still work
- [ ] Empty state suggestions still fire correctly
- [ ] Chat clear resets everything (entry context, classification state, follow-up pills)
- [ ] TypeScript strict mode passes with no `any` types
