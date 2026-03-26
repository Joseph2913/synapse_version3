# PRD-B — Context-Aware Chat Entry Points

**Phase:** Intelligence (post-Phase 3)
**Dependencies:** PRD-A (Chat Entry Context System)
**Estimated complexity:** High (many files touched, per-entry-point tuning)
**Depends on:** `ChatEntryContext`, `ChatScope`, scoped RAG pipeline, system directive injection — all from PRD-A

---

## 1. Objective

Upgrade every existing chat redirect in the application — and add new ones to views that currently lack them — so that each entry point passes a full `ChatEntryContext` with a tailored system directive, optimised query configuration, and precise scope constraints.

Today, all 9 existing redirects pass a flat `{ autoQuery: string }`. After this PRD, each one passes the right combination of hidden instructions, retrieval settings, and scope locks so that the AI response is shaped for the specific use case. Four views that currently have no path to Ask (Capture, Pipeline, Orient, Anchors) also gain chat redirect buttons.

---

## 2. What Gets Built

### 2.1 Shared Utility: Entry Context Builder

**New file: `src/utils/chatEntryContexts.ts`**

A centralised module of builder functions, one per entry point. Each function accepts the data available at its call site and returns a complete `ChatEntryContext`. This keeps the context-building logic out of the view components and makes it testable independently.

```typescript
import type { ChatEntryContext } from '../types/chatContext'
import type { KnowledgeNode } from '../types/database'

// ─── Home Feed: Entity Detail ─────────────────────────────────────────────
export function buildEntityExploreContext(node: KnowledgeNode): ChatEntryContext
export function buildEntitySimilarContext(node: KnowledgeNode): ChatEntryContext

// ─── Home Feed: Relationship Detail ───────────────────────────────────────
export function buildRelationshipChatContext(params: {
  fromNodeId: string; fromLabel: string; fromEntityType: string
  toNodeId: string; toLabel: string; toEntityType: string
  relationType: string; isExternal: boolean; isAnchor: boolean
}): ChatEntryContext

// ─── Home Feed: Source Card ───────────────────────────────────────────────
export function buildSourceChatContext(params: {
  sourceId: string; title: string; sourceType: string
}): ChatEntryContext

// ─── Home Feed: Source × Anchor ───────────────────────────────────────────
export function buildSourceAnchorContext(params: {
  sourceId: string; sourceTitle: string
  anchorNodeId: string; anchorLabel: string
}): ChatEntryContext

// ─── Home Feed: Source × Source ───────────────────────────────────────────
export function buildSourceCompareContext(params: {
  sourceIdA: string; titleA: string
  sourceIdB: string; titleB: string
}): ChatEntryContext

// ─── Explore: Entity Browser ──────────────────────────────────────────────
export function buildBrowseEntityExploreContext(entity: {
  id: string; label: string; entity_type: string; source_id?: string | null
}): ChatEntryContext

// ─── Explore: Source Connection ───────────────────────────────────────────
export function buildSourceConnectionContext(params: {
  sourceA: { id: string; title: string; sourceType: string }
  sourceB: { id: string; title: string; sourceType: string }
  connectionSummary: string  // The prompt from buildConnectionPrompt
}): ChatEntryContext

// ─── Capture: Post-Extraction ─────────────────────────────────────────────
export function buildPostExtractionContext(params: {
  sourceId: string; sourceTitle: string; sourceType: string
  entityCount: number; relationshipCount: number
}): ChatEntryContext

// ─── Pipeline: Extraction Detail ──────────────────────────────────────────
export function buildExtractionDetailContext(params: {
  sourceId: string; title: string; sourceType: string
  entityCount: number
}): ChatEntryContext

// ─── Orient: Digest Drilldown ─────────────────────────────────────────────
export function buildDigestDrilldownContext(params: {
  profileTitle: string; executiveSummary: string
  moduleTitles: string[]
}): ChatEntryContext

// ─── Anchors: Explore Anchor ──────────────────────────────────────────────
export function buildAnchorExploreContext(params: {
  nodeId: string; label: string; entityType: string
  description: string | null
}): ChatEntryContext
```

---

## 3. Per-Entry-Point Specifications

### 3.1 Home Feed → Explore with AI (entity)

**Data available:** Full `KnowledgeNode` (id, label, entity_type, description, source_id, is_anchor, confidence, tags)

**autoQuery:**
```
Tell me about "{label}" ({entity_type}). What is its significance in my knowledge graph, what key insights are associated with it, and how does it connect to other important concepts?
```

**systemDirective:**
```
The user is exploring a single entity from their Home feed. They can already see its label, type, confidence score, and description — do not repeat these. Focus on: (1) what multiple sources say about this entity and any differences between them, (2) its most significant relationships to other entities and why those relationships matter, (3) any patterns or themes that emerge from its connections. If this is an Anchor, emphasise its role as a connective hub across sources.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'exploratory', toolMode: 'deep' }
```

**scope:**
```typescript
{
  entityIds: [node.id],
  sourceIds: node.source_id ? [node.source_id] : undefined,
}
```

**displayLabel:** `Exploring: {label}`

**entryPoint:** `home_entity_explore`

---

### 3.2 Home Feed → Find Similar (entity)

**Data available:** Full `KnowledgeNode`

**autoQuery:**
```
What concepts, entities, or ideas in my knowledge graph are most similar to "{label}"? Find related {entity_type} entries and explain what they have in common.
```

**systemDirective:**
```
The user wants to discover entities similar to the one they are viewing. Prioritise: (1) entities of the same type that share relationships or appear in the same sources, (2) entities with high semantic similarity based on descriptions or context, (3) entities connected to the same anchors. Present results as a ranked list with a brief explanation of why each is similar. End with one surprising or non-obvious connection the user might not expect.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'exploratory', toolMode: 'deep' }
```

**scope:**
```typescript
{ useEntityEmbedding: node.id }
```

**displayLabel:** `Similar to: {label}`

**entryPoint:** `home_entity_similar`

---

### 3.3 Home Feed → Chat about this relationship (edge)

**Data available:** `UnifiedConnection` (fromNodeId, fromLabel, fromEntityType, toNodeId, toLabel, toEntityType, relationType, isExternal, isAnchor, sourceName, toSourceId)

**autoQuery:**
```
Explain the relationship between "{fromLabel}" and "{toLabel}". They are connected by "{relationType}" — what does this relationship mean, what insights does it reveal, and what are the broader implications for understanding both concepts together?
```

**systemDirective:**
```
The user is examining a specific relationship between two entities. They can already see both labels, the relation type ({relationType}), and whether it crosses sources. Do not restate the relationship — explain it. Focus on: (1) the evidence from source material that supports this connection, (2) whether different sources agree or add different nuances to this relationship, (3) downstream implications — what does this relationship enable or put at risk?{isExternal ? ' This is a cross-source relationship, so emphasise what insight emerges from the intersection of these two sources.' : ''}{isAnchor ? ' One side is an anchor concept — explain how this relationship reinforces the anchor\'s significance.' : ''}
```

**queryConfigOverrides:**
```typescript
{ mindset: 'analytical', toolMode: 'quick' }
```

**scope:**
```typescript
{ entityIds: [fromNodeId, toNodeId] }
```

**displayLabel:** `{fromLabel} → {toLabel}`

**entryPoint:** `home_relationship_chat`

---

### 3.4 Home Feed → Chat with source (source card)

**Data available:** `item.source` (id, title, source_type, summary, metadata)

**autoQuery:**
```
Tell me about "{title}" in depth. What are the key arguments, specific details, important decisions, and notable insights in this source? Go beyond the summary.
```

**systemDirective:**
```
The user wants a focused conversation about a specific ingested source document. They have already seen the summary and extracted entity list — do not repeat them. Instead: (1) go deeper into the most substantive content — specific arguments, data points, decisions, quotes, and action items, (2) highlight anything the extraction may have missed or understated, (3) connect the source's themes to the rest of the graph, but keep this source as the primary subject. Structure as: key themes with depth → notable specifics → connections to the broader graph.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'factual', toolMode: 'quick' }
```

**scope:**
```typescript
{ sourceIds: [item.source.id] }
```

**displayLabel:** `Source: {title}`

**entryPoint:** `home_source_chat`

---

### 3.5 Home Feed → Ask how this relates (source × anchor)

**Data available:** `item.source` (id, title) + anchor (nodeId, label)

**autoQuery:**
```
How does "{sourceTitle}" relate to "{anchorLabel}"? What are the key connections, shared themes, and insights that link them together?
```

**systemDirective:**
```
The user is investigating how a specific source connects to a specific anchor topic. The anchor is a high-level persistent concept in their knowledge graph. Focus on: (1) which entities extracted from this source connect to the anchor and how, (2) what this source adds to the user's understanding of the anchor that other sources do not, (3) whether this source confirms, extends, or challenges what other anchor-connected sources say. Frame the answer as: "Here is what this source contributes to your understanding of {anchorLabel}."
```

**queryConfigOverrides:**
```typescript
{ mindset: 'analytical', toolMode: 'deep' }
```

**scope:**
```typescript
{
  sourceIds: [item.source.id],
  anchorIds: [anchor.nodeId],
}
```

**displayLabel:** `{sourceTitle} × {anchorLabel}`

**entryPoint:** `home_source_anchor`

---

### 3.6 Home Feed → Compare sources (source × source)

**Data available:** `item.source` (id, title) + related source (sourceId, title)

**autoQuery:**
```
Compare "{titleA}" with "{titleB}". What are the key similarities, differences, and complementary insights between them?
```

**systemDirective:**
```
The user wants a structured comparison between two specific sources. Deliver a comparison that: (1) identifies the 2–3 most important shared themes and how each source treats them, (2) highlights what is unique to each source that the other does not cover, (3) surfaces any tensions or contradictions between them, (4) ends with a synthesis: "Together, these sources tell you X." Keep attribution clear throughout — never blend which source said what.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'comparative', toolMode: 'deep' }
```

**scope:**
```typescript
{ sourceIds: [item.source.id, otherSource.sourceId] }
```

**displayLabel:** `Comparing: {titleA} vs {titleB}`

**entryPoint:** `home_source_compare`

---

### 3.7 Explore → Entity Browser → Explore with AI

**Data available:** Entity from browser (id, label, entity_type, source_id)

**autoQuery:**
```
Tell me about "{label}" and its connections in my knowledge graph.
```

**systemDirective:**
```
The user selected this entity from the Explore browser. They want an overview of what this entity represents, its key relationships, and what sources mention it. Prioritise breadth — surface the most important connections and let the user drill deeper with follow-ups.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'exploratory', toolMode: 'deep' }
```

**scope:**
```typescript
{
  entityIds: [entity.id],
  sourceIds: entity.source_id ? [entity.source_id] : undefined,
}
```

**displayLabel:** `Exploring: {label}`

**entryPoint:** `explore_entity_browse`

---

### 3.8 Explore → Source Graph → Ask about connection

**Data available:** `selectedSource` (SourceNode), `otherSource` (SourceNode), `edge` (SourceEdge), `sharedEntities` (KnowledgeNode[]), plus the prompt from `buildConnectionPrompt`

**autoQuery:** The dynamically built prompt from the existing `buildConnectionPrompt()` function (varies based on dominant connection type — entity overlap, tag, anchor, same-type, general). Keep the existing prompt-building logic; it is already well-designed.

**systemDirective:**
```
The user is exploring the connection between two sources in the Source Graph view. They can see the source titles, connection types, and shared entities. Go deeper into: (1) the significance of the shared entities or themes between these sources, (2) what each source adds that the other does not, (3) whether the connection reveals a pattern or insight the user might not have noticed. Keep the analysis grounded in the source material.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'analytical', toolMode: 'deep' }
```

**scope:**
```typescript
{ sourceIds: [sourceA.id, sourceB.id] }
```

**displayLabel:** `Connection: {sourceA.title} ↔ {sourceB.title}`

**entryPoint:** `explore_source_connection`

---

### 3.9 Explore → NodeDetailPanel → Explore with AI (bug fix + upgrade)

**Data available:** Full entity (id, label, entity_type, source_id, etc.)

This entry point currently uses `window.location.href` (a full page reload) with a query param that AskView doesn't read. PRD-A added a minimal fix. This PRD upgrades it to a full context-aware redirect using the same spec as 3.1 (Home Feed → Explore with AI) but with `entryPoint: 'explore_entity_graph'`.

---

### 3.10 Capture → Post-Extraction Chat (NEW)

**Data available:** `state.sourceId`, `state.savedNodes` (array of SavedNode), `state.savedEdgeIds`, `state.crossConnectionCount`, source title from form state

**Where it appears:** In the completion panel alongside the existing "View in Browse" button.

**Button spec:**
- Label: "Chat with what you captured"
- Icon: `MessageSquare` (12px), matching the existing "View in Browse" button style
- Styling: matches `actionBtnStyle` in HomeFeedDetail — `var(--color-bg-inset)` background, `var(--border-subtle)` border, 7px radius, 12px DM Sans weight 600
- Position: below "View in Browse", above "Capture Another"

**autoQuery:**
```
I just ingested "{sourceTitle}" ({sourceType}). It produced {entityCount} entities and {relationshipCount} relationships. What are the most important things it contains, and how does it connect to what I already know?
```

**systemDirective:**
```
The user just completed an extraction and wants to understand what they captured. This is their first interaction with this source — make it count. Focus on: (1) the most substantive entities and relationships that were extracted, (2) how this new content connects to the user's existing knowledge graph (cross-connections), (3) any gaps or areas where the extraction may have missed important details. Be specific about entity names, relationship types, and source content. The user values depth and specificity.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'analytical', toolMode: 'deep' }
```

**scope:**
```typescript
{ sourceIds: [state.sourceId] }
```

**displayLabel:** `Just captured: {sourceTitle}`

**entryPoint:** `capture_post_extraction`

---

### 3.11 Pipeline → Extraction Detail Chat (NEW)

**Data available:** `PipelineHistoryItem` (sourceId, title, sourceType, entityCount, relationshipCount, confidence, crossConnections)

**Where it appears:** In the ExtractionDetail panel alongside the existing (non-functional) "Re-extract" button.

**Button spec:**
- Label: "Ask about this extraction"
- Icon: `MessageSquare` (13px)
- Styling: uses `ActionButton` component already defined in ExtractionDetail — secondary style, full width
- Position: in the Actions section, above "Re-extract"

**autoQuery:**
```
Tell me about "{title}". This {sourceType} produced {entityCount} entities. What are the key insights, and how does it connect to the rest of my knowledge?
```

**systemDirective:**
```
The user is reviewing a past extraction in the Pipeline view. They can see the entity count, relationship count, and confidence score. Give them a substantive analysis of what this source contains and how it fits into their broader knowledge graph. Highlight cross-connections to other sources and any surprising or high-value entities.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'factual', toolMode: 'quick' }
```

**scope:**
```typescript
{ sourceIds: item.sourceId ? [item.sourceId] : undefined }
```

**displayLabel:** `Extraction: {title}`

**entryPoint:** `pipeline_extraction_detail`

---

### 3.12 Orient → Digest Drilldown Chat (NEW)

**Data available:** `DigestOutput` (profileId, title, executiveSummary, modules[].content), `DigestProfile` (title, frequency)

**Where it appears:** In the DigestViewer modal, below the executive summary.

**Button spec:**
- Label: "Dig deeper"
- Icon: `MessageSquare` (13px)
- Styling: accent-50 background, accent-500 text, accent border at 15% opacity, 8px radius, 12px DM Sans weight 600, full width
- Position: below the executive summary, above the module sections

**autoQuery:**
```
Based on my {frequency} digest "{profileTitle}", dig deeper into the key themes. The executive summary is: "{executiveSummary}". What additional context, connections, and implications should I be aware of?
```

**systemDirective:**
```
The user has read a digest briefing and wants to go deeper. The digest was auto-generated from their knowledge graph. Do not repeat the executive summary — they have already read it. Instead: (1) expand on the most important points with specific evidence from source material, (2) surface connections between the digest themes that the briefing did not cover, (3) identify any contradictions, open questions, or gaps in the user's knowledge on these topics. Treat this as a senior advisor following up on a briefing.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'analytical', toolMode: 'deep' }
```

**scope:** None — digest topics span the full graph, so broad search is appropriate.

**displayLabel:** `Briefing: {profileTitle}`

**entryPoint:** `orient_digest_drilldown`

---

### 3.13 Anchors → Explore Anchor Chat (NEW)

**Data available:** `AnchorCandidateWithNode` (node.id, node.label, node.entity_type, node.description, signal scores)

**Where it appears:** In the AnchorDetailPanel, in the actions area.

**Button spec:**
- Label: "Explore with AI"
- Icon: `Sparkles` (13px)
- Styling: accent-50 background, accent-500 text, accent border at 15% opacity, 8px radius, 12px DM Sans weight 600, full width
- Position: at the top of the actions section, before Confirm/Dismiss buttons

**autoQuery:**
```
Explore the anchor topic "{label}" ({entityType}). What are the most important entities, sources, and themes connected to it? How central is it to my knowledge graph?
```

**systemDirective:**
```
The user is evaluating an anchor candidate in the Anchors view. They can see the node's label, type, description, and signal scores (centrality, diversity, velocity, richness). Help them understand: (1) what makes this topic significant as a potential anchor — what sources feed into it and what themes it connects, (2) what the anchor's neighbourhood looks like — its most important connected entities and relationships, (3) whether it overlaps with existing anchors or fills a gap. The user is deciding whether to promote this entity to anchor status, so provide evidence that helps them make that judgment.
```

**queryConfigOverrides:**
```typescript
{ mindset: 'exploratory', toolMode: 'deep' }
```

**scope:**
```typescript
{ entityIds: [node.id] }
```

**displayLabel:** `Anchor: {label}`

**entryPoint:** `anchors_explore`

---

## 4. Design Requirements

### Existing Buttons (3.1–3.9)

No visual changes to the existing buttons. They retain their current labels, icons, styling, and positions. Only the `onClick` handler changes — from passing `{ autoQuery }` to passing the full `ChatEntryContext`.

### New Buttons (3.10–3.13)

All new buttons follow the design system:

- **Font:** DM Sans, 12px, weight 600
- **Icons:** Lucide React, 12–13px, placed before the label with 6px gap
- **Border radius:** 7–8px
- **Transitions:** background 0.12s ease on hover
- **Cursor:** pointer

**Capture (3.10):** Matches existing action button row — `var(--color-bg-inset)` background, `var(--border-subtle)` border. Hover: `var(--color-bg-card)`.

**Pipeline (3.11):** Uses existing `ActionButton` component from ExtractionDetail. Secondary style.

**Orient (3.12):** Accent-tinted — `var(--color-accent-50)` background, `var(--color-accent-500)` text, `rgba(214,58,0,0.15)` border. Hover: background darkens to `rgba(214,58,0,0.1)`. Full width.

**Anchors (3.13):** Same accent-tinted style as Orient. Full width, positioned at top of actions area.

---

## 5. Data & Service Layer

No new service functions or database queries. All data required to build the `ChatEntryContext` is already available at each call site (entity IDs, source IDs, labels, types, etc.). The builder functions in `chatEntryContexts.ts` are pure functions that construct the context object from existing data.

The heavy lifting — scoped retrieval, system directive injection, pipeline routing — is handled by PRD-A's infrastructure.

---

## 6. Interaction & State

Every entry point follows the same pattern:

1. User clicks the button
2. The builder function constructs a `ChatEntryContext` from the available data
3. `navigate('/ask', { state: context })` fires
4. AskView reads the context via `normalizeEntryContext` (PRD-A)
5. `sendWithContext(context)` fires the scoped, directive-enhanced query
6. User sees the auto-query in the chat, receives a response shaped by the directive and scope
7. Follow-up messages inherit the scope and directive (PRD-A persistence)
8. User can override mindset/tool mode/model tier via the toolbar at any time

No new state management. No new context providers. No new hooks. The builder functions are stateless utilities.

---

## 7. Forward-Compatible Decisions

- **Builder functions are composable.** If a future PRD introduces a new entry point (e.g., Chrome Extension → Ask), it adds one function to `chatEntryContexts.ts`. No other files change.

- **System directives are tunable.** The directive strings in this PRD are starting points. They can be refined based on real-world response quality without any code changes beyond updating the string in the builder function.

- **PRD-C (in-chat interactions) will add new builder functions** for citation-click and entity-click contexts. The same pattern extends naturally.

- **The `buildConnectionPrompt` function in ExploreMetadataPanel is preserved.** Entry point 3.8 wraps it in a `ChatEntryContext` rather than replacing it, since the existing prompt logic is well-designed with 5 branching variants based on connection type.

---

## 8. Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| Entity has no `source_id` (manually created or migrated) | `scope.sourceIds` is omitted, pipeline uses standard keyword/semantic search for chunks |
| Pipeline item has `sourceId: null` (failed extraction) | `scope.sourceIds` is omitted, falls back to standard pipeline |
| Digest has no modules (empty generation) | Button is hidden — do not show "Dig deeper" on an empty digest |
| Anchor candidate has `node: null` | Button is hidden — cannot build context without node data |
| Source title is null | Fallback to `'Untitled Source'` in both autoQuery and displayLabel |
| User clicks chat button while already on Ask view with an active conversation | Standard navigation replaces current state, AskView re-mounts, previous conversation is lost. This is acceptable — the user explicitly chose a new context. |
| Two sources being compared are the same source | Fallback to source chat context (3.4) instead of compare context (3.6) |

---

## 9. Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `src/utils/chatEntryContexts.ts` | Builder functions for all 13 entry point contexts |

### Modified Files

| File | Change |
|---|---|
| `src/components/home/HomeFeedDetail.tsx` | Replace 6 `navigate('/ask', { state: { autoQuery } })` calls with builder functions |
| `src/views/explore/EntityBrowserTab.tsx` | Replace 1 `navigate` call with `buildBrowseEntityExploreContext` |
| `src/views/explore/ExploreMetadataPanel.tsx` | Wrap `buildConnectionPrompt` result in `buildSourceConnectionContext` |
| `src/components/explore/NodeDetailPanel.tsx` | Upgrade PRD-A minimal fix to full `ChatEntryContext` with scope and directive |
| `src/views/CaptureView.tsx` | Add "Chat with what you captured" button in completion panel |
| `src/components/pipeline/ExtractionDetail.tsx` | Add "Ask about this extraction" button in actions section |
| `src/components/home/DigestViewer.tsx` | Add "Dig deeper" button below executive summary |
| `src/components/anchors/AnchorDetailPanel.tsx` | Add "Explore with AI" button in actions area |

---

## 10. Acceptance Criteria

After this PRD is complete:

**Existing entry points upgraded (no visual change, better responses):**
- [ ] Home Feed → "Explore with AI" passes a full `ChatEntryContext` with exploratory mindset, entity scope, and system directive
- [ ] Home Feed → "Find Similar" passes context with `useEntityEmbedding` scope (entity's own vector used for search)
- [ ] Home Feed → "Chat about this relationship" passes context with analytical mindset, both entity IDs in scope, and relationship-specific directive
- [ ] Home Feed → "Chat with source" passes context with factual mindset, source-locked scope, and depth-over-summary directive
- [ ] Home Feed → "Ask how this relates" passes context with dual scope (source + anchor) and anchor-contribution directive
- [ ] Home Feed → "Compare sources" passes context with comparative mindset, both source IDs in scope, and balanced-comparison directive
- [ ] Explore → Entity Browser "Explore with AI" passes full context with entity scope
- [ ] Explore → Source Graph "Ask about connection" passes full context with dual source scope
- [ ] Explore → NodeDetailPanel "Explore with AI" uses `navigate()` with full context (no more `window.location.href`)

**New entry points added (new buttons):**
- [ ] Capture view shows "Chat with what you captured" button after extraction completes, navigates to Ask with source-locked scope
- [ ] Pipeline ExtractionDetail shows "Ask about this extraction" button, navigates to Ask with source scope
- [ ] Orient DigestViewer shows "Dig deeper" button below executive summary, navigates to Ask with no scope (broad graph search)
- [ ] Anchors AnchorDetailPanel shows "Explore with AI" button, navigates to Ask with entity scope

**New buttons are correctly hidden when data is missing:**
- [ ] Capture button hidden when `state.sourceId` is null
- [ ] Pipeline button hidden when `item.sourceId` is null
- [ ] Orient button hidden when digest has no modules
- [ ] Anchors button hidden when `candidate.node` is null

**Quality:**
- [ ] All builder functions are pure, typed, and located in `src/utils/chatEntryContexts.ts`
- [ ] No inline `ChatEntryContext` construction in view components — all go through builder functions
- [ ] Backward compatibility: legacy `{ autoQuery }` still works via `normalizeEntryContext` from PRD-A
- [ ] All new buttons match the design system (DM Sans 12px/600, correct backgrounds, hover states, border radius)
- [ ] No new `any` types — TypeScript strict mode passes
