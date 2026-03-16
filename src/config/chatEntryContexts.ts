import type { ChatEntryContext } from '../types/chatRouting'
import type { KnowledgeNode } from '../types/database'

// ─── Builder: Entity Explore ─────────────────────────────────────────────────

export function buildEntityExploreContext(node: KnowledgeNode): ChatEntryContext {
  return {
    autoQuery: `Tell me about "${node.label}" — what do my sources say about it, what are its key relationships, and what insights emerge from the graph?`,
    systemDirective: `CONTEXT: The user arrived from an entity detail panel on the Home feed.
They can already see this entity's label, type, confidence score, description, and tags.
DO NOT repeat information they already have.

INSTRUCTIONS:
- Focus on what MULTIPLE SOURCES say about this entity — synthesize across sources.
- Highlight the entity's most significant RELATIONSHIPS, explaining the evidence.
- Surface any CONTRADICTIONS or evolving perspectives across different sources.
- If this is an Anchor, emphasize its role as a connective hub.
- End with 1-2 follow-up questions the user might want to explore.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: { entityIds: [node.id], mode: 'soft' },
    entryPoint: 'entity_explore',
    displayLabel: `Exploring: ${node.label}`,
    metadata: { entityType: node.entity_type },
  }
}

// ─── Builder: Entity Find Similar ────────────────────────────────────────────

export function buildEntityFindSimilarContext(node: KnowledgeNode): ChatEntryContext {
  return {
    autoQuery: `What entities in my knowledge graph are most similar to "${node.label}"?`,
    systemDirective: `CONTEXT: The user wants to discover entities SIMILAR to the one they're viewing.
They are in a discovery mindset — lateral connections, not deep analysis.

INSTRUCTIONS:
- Present results as a RANKED LIST of 5-8 similar entities.
- For each: label, type, and ONE-LINE explanation of WHY it's similar.
- Prioritize same-type entities sharing relationships or sources.
- Then broaden to entities connected by the same anchors or tags.
- End with ONE surprising connection they wouldn't expect.
- Keep it scannable — no deep analysis of any single entity.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: { entityIds: [node.id], mode: 'soft' },
    entryPoint: 'entity_find_similar',
    displayLabel: `Similar to: ${node.label}`,
    metadata: { entityType: node.entity_type },
  }
}

// ─── Builder: Relationship Chat ──────────────────────────────────────────────

export function buildRelationshipChatContext(conn: {
  fromNodeId: string
  fromLabel: string
  toNodeId: string
  toLabel: string
  relationType: string
  evidence?: string | null
  weight?: number | null
}): ChatEntryContext {
  return {
    autoQuery: `Explain the relationship between "${conn.fromLabel}" and "${conn.toLabel}" (${conn.relationType}).`,
    systemDirective: `CONTEXT: The user is examining a specific relationship between two entities.
They can see: from-entity, to-entity, relation type, cross-source status.
DO NOT restate the relationship — explain it.

EXTRACTION EVIDENCE: ${conn.evidence ?? 'No extraction evidence available'}
EDGE WEIGHT: ${conn.weight ?? 'unknown'}

INSTRUCTIONS:
- Explain the EVIDENCE from source chunks that supports this connection.
- If cross-source, emphasize the insight from the intersection.
- Discuss DOWNSTREAM IMPLICATIONS — what does this enable or risk?
- Keep focused — one specific connection, not the broader graph.`,
    queryConfig: { mindset: 'analytical', toolMode: 'quick' },
    scope: { entityIds: [conn.fromNodeId, conn.toNodeId], mode: 'hard' },
    entryPoint: 'relationship_chat',
    displayLabel: `${conn.fromLabel} → ${conn.toLabel}`,
  }
}

// ─── Builder: Source Chat ────────────────────────────────────────────────────

export function buildSourceChatContext(source: { id: string; title?: string | null; summary?: string | null }): ChatEntryContext {
  const title = source.title ?? 'this source'
  return {
    autoQuery: `Tell me about "${title}" — go deeper than the summary. What are the key arguments, data points, and insights?`,
    systemDirective: `CONTEXT: The user wants a focused conversation about a SINGLE source.
They can see the summary and extracted entities. DO NOT repeat the summary.

SOURCE SUMMARY (user has seen this): ${source.summary ?? 'No summary available'}

INSTRUCTIONS:
- Go DEEPER — surface specific arguments, data points, decisions, quotes.
- Highlight anything the extraction may have missed.
- Structure: Key Themes (with depth) → Notable Specifics → Open Questions.
- Keep this source as PRIMARY subject. Graph connections are secondary.
- All citations should reference THIS source unless making a graph connection.`,
    queryConfig: { mindset: 'factual', toolMode: 'quick' },
    scope: { sourceIds: [source.id], mode: 'hard' },
    entryPoint: 'source_chat',
    displayLabel: `Chatting: ${title}`,
  }
}

// ─── Builder: Source-Anchor Relate ───────────────────────────────────────────

export function buildSourceAnchorRelateContext(
  source: { id: string; title?: string | null },
  anchor: { nodeId: string; label: string }
): ChatEntryContext {
  const title = source.title ?? 'this source'
  return {
    autoQuery: `How does "${title}" relate to "${anchor.label}"? What connections and shared themes link them?`,
    systemDirective: `CONTEXT: The user is investigating how a source connects to an anchor topic.

ANCHOR: "${anchor.label}"
SOURCE: "${title}"

INSTRUCTIONS:
- Identify which entities from this source connect to the anchor and HOW.
- Explain what this source ADDS to understanding the anchor.
- Briefly note whether it CONFIRMS, EXTENDS, or CHALLENGES other anchor-connected sources.
- Frame as: "Here's what this source contributes to your understanding of [anchor]."`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: { sourceIds: [source.id], anchorIds: [anchor.nodeId], mode: 'soft' },
    entryPoint: 'source_anchor_relate',
    displayLabel: `${title} × ${anchor.label}`,
  }
}

// ─── Builder: Source Compare ─────────────────────────────────────────────────

export function buildSourceCompareContext(
  sourceA: { id: string; title?: string | null },
  sourceB: { id: string; title?: string | null }
): ChatEntryContext {
  const titleA = sourceA.title ?? 'Source A'
  const titleB = sourceB.title ?? 'Source B'
  return {
    autoQuery: `Compare "${titleA}" with "${titleB}". What are the key similarities, differences, and complementary insights?`,
    systemDirective: `CONTEXT: Structured comparison between two specific sources.

SOURCE A: "${titleA}"
SOURCE B: "${titleB}"

INSTRUCTIONS:
- Identify 2-3 most important SHARED THEMES and how each source treats them.
- Highlight what's UNIQUE to each source.
- Surface TENSIONS or contradictions.
- End with synthesis: "Together, these sources tell you X."
- CRITICAL: Keep attribution clear. Never blend which source said what.
- Structure: Shared Themes → Unique to A → Unique to B → Tensions → Synthesis.`,
    queryConfig: { mindset: 'comparative', toolMode: 'deep' },
    scope: { sourceIds: [sourceA.id, sourceB.id], mode: 'hard' },
    entryPoint: 'source_compare',
    displayLabel: `Comparing: ${titleA} vs ${titleB}`,
  }
}
