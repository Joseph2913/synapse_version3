import type { ChatEntryContext } from '../types/chatRouting'
import type { KnowledgeNode, AgentInsightRow } from '../types/database'

// ─── Home Feed: Entity Explore (§3.1) ───────────────────────────────────────

export function buildEntityExploreContext(node: KnowledgeNode): ChatEntryContext {
  return {
    autoQuery: `Tell me about "${node.label}" (${node.entity_type}). What is its significance in my knowledge graph, what key insights are associated with it, and how does it connect to other important concepts?`,
    systemDirective: `The user is exploring a single entity from their Home feed. They can already see its label, type, confidence score, and description — do not repeat these. Focus on: (1) what multiple sources say about this entity and any differences between them, (2) its most significant relationships to other entities and why those relationships matter, (3) any patterns or themes that emerge from its connections. If this is an Anchor, emphasise its role as a connective hub across sources.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: {
      entityIds: [node.id],
      sourceIds: node.source_id ? [node.source_id] : undefined,
      mode: 'soft',
    },
    entryPoint: 'home_entity_explore',
    displayLabel: `Exploring: ${node.label}`,
    metadata: { entityType: node.entity_type },
  }
}

// ─── Home Feed: Entity Find Similar (§3.2) ──────────────────────────────────

export function buildEntityFindSimilarContext(node: KnowledgeNode): ChatEntryContext {
  return {
    autoQuery: `What concepts, entities, or ideas in my knowledge graph are most similar to "${node.label}"? Find related ${node.entity_type} entries and explain what they have in common.`,
    systemDirective: `The user wants to discover entities similar to the one they are viewing. Prioritise: (1) entities of the same type that share relationships or appear in the same sources, (2) entities with high semantic similarity based on descriptions or context, (3) entities connected to the same anchors. Present results as a ranked list with a brief explanation of why each is similar. End with one surprising or non-obvious connection the user might not expect.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: { useEntityEmbedding: node.id, mode: 'soft' },
    entryPoint: 'home_entity_similar',
    displayLabel: `Similar to: ${node.label}`,
    metadata: { entityType: node.entity_type },
  }
}

// ─── Home Feed: Relationship Chat (§3.3) ────────────────────────────────────

export function buildRelationshipChatContext(conn: {
  fromNodeId: string
  fromLabel: string
  toNodeId: string
  toLabel: string
  relationType: string
  isExternal?: boolean
  isAnchor?: boolean
  evidence?: string | null
  weight?: number | null
}): ChatEntryContext {
  return {
    autoQuery: `Explain the relationship between "${conn.fromLabel}" and "${conn.toLabel}". They are connected by "${conn.relationType}" — what does this relationship mean, what insights does it reveal, and what are the broader implications for understanding both concepts together?`,
    systemDirective: `The user is examining a specific relationship between two entities. They can already see both labels, the relation type (${conn.relationType}), and whether it crosses sources. Do not restate the relationship — explain it. Focus on: (1) the evidence from source material that supports this connection, (2) whether different sources agree or add different nuances to this relationship, (3) downstream implications — what does this relationship enable or put at risk?${conn.isExternal ? ' This is a cross-source relationship, so emphasise what insight emerges from the intersection of these two sources.' : ''}${conn.isAnchor ? " One side is an anchor concept — explain how this relationship reinforces the anchor's significance." : ''}`,
    queryConfig: { mindset: 'analytical', toolMode: 'quick' },
    scope: { entityIds: [conn.fromNodeId, conn.toNodeId], mode: 'hard' },
    entryPoint: 'home_relationship_chat',
    displayLabel: `${conn.fromLabel} → ${conn.toLabel}`,
  }
}

// ─── Home Feed: Source Chat (§3.4) ──────────────────────────────────────────

export function buildSourceChatContext(source: { id: string; title?: string | null; summary?: string | null }): ChatEntryContext {
  const title = source.title ?? 'Untitled Source'
  return {
    autoQuery: `Tell me about "${title}" in depth. What are the key arguments, specific details, important decisions, and notable insights in this source? Go beyond the summary.`,
    systemDirective: `The user wants a focused conversation about a specific ingested source document. They have already seen the summary and extracted entity list — do not repeat them. Instead: (1) go deeper into the most substantive content — specific arguments, data points, decisions, quotes, and action items, (2) highlight anything the extraction may have missed or understated, (3) connect the source's themes to the rest of the graph, but keep this source as the primary subject. Structure as: key themes with depth → notable specifics → connections to the broader graph.`,
    queryConfig: { mindset: 'factual', toolMode: 'quick' },
    scope: { sourceIds: [source.id], mode: 'hard' },
    entryPoint: 'home_source_chat',
    displayLabel: `Source: ${title}`,
  }
}

// ─── Home Feed: Source × Anchor (§3.5) ──────────────────────────────────────

export function buildSourceAnchorRelateContext(
  source: { id: string; title?: string | null },
  anchor: { nodeId: string; label: string }
): ChatEntryContext {
  const title = source.title ?? 'Untitled Source'
  return {
    autoQuery: `How does "${title}" relate to "${anchor.label}"? What are the key connections, shared themes, and insights that link them together?`,
    systemDirective: `The user is investigating how a specific source connects to a specific anchor topic. The anchor is a high-level persistent concept in their knowledge graph. Focus on: (1) which entities extracted from this source connect to the anchor and how, (2) what this source adds to the user's understanding of the anchor that other sources do not, (3) whether this source confirms, extends, or challenges what other anchor-connected sources say. Frame the answer as: "Here is what this source contributes to your understanding of ${anchor.label}."`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: { sourceIds: [source.id], anchorIds: [anchor.nodeId], mode: 'soft' },
    entryPoint: 'home_source_anchor',
    displayLabel: `${title} × ${anchor.label}`,
  }
}

// ─── Home Feed: Source Compare (§3.6) ───────────────────────────────────────

export function buildSourceCompareContext(
  sourceA: { id: string; title?: string | null },
  sourceB: { id: string; title?: string | null }
): ChatEntryContext {
  const titleA = sourceA.title ?? 'Source A'
  const titleB = sourceB.title ?? 'Source B'
  return {
    autoQuery: `Compare "${titleA}" with "${titleB}". What are the key similarities, differences, and complementary insights between them?`,
    systemDirective: `The user wants a structured comparison between two specific sources. Deliver a comparison that: (1) identifies the 2–3 most important shared themes and how each source treats them, (2) highlights what is unique to each source that the other does not cover, (3) surfaces any tensions or contradictions between them, (4) ends with a synthesis: "Together, these sources tell you X." Keep attribution clear throughout — never blend which source said what.`,
    queryConfig: { mindset: 'comparative', toolMode: 'deep' },
    scope: { sourceIds: [sourceA.id, sourceB.id], mode: 'hard' },
    entryPoint: 'home_source_compare',
    displayLabel: `Comparing: ${titleA} vs ${titleB}`,
  }
}

// ─── Home Feed: Multi-Source Compare (§3.6b) ──────────────────────────────────

export function buildMultiSourceCompareContext(
  primarySource: { id: string; title?: string | null },
  relatedSources: { id: string; title?: string | null }[]
): ChatEntryContext {
  const primaryTitle = primarySource.title ?? 'Primary Source'
  const allSources = [primarySource, ...relatedSources]
  const allIds = allSources.map(s => s.id)

  return {
    autoQuery: `What are the key insights from "${primaryTitle}" and how does it connect to related sources in my graph?`,
    systemDirective: `The user is exploring "${primaryTitle}" in the context of their broader knowledge graph. ${relatedSources.length} related sources are in scope. Keep the response SHORT (200–300 words). "${primaryTitle}" is the PRIMARY FOCUS — related sources are supporting context only.

Structure your response EXACTLY as follows:

**Source Summary**
2–3 sentences: the core argument, key takeaways, and "so what" of "${primaryTitle}".

**Connections Across Your Graph**
2–3 connections, each 1–2 sentences. For each: name the related source, then state the SPECIFIC BRIDGE — how it connects back to "${primaryTitle}". Do NOT summarise what the related source is about on its own. Only state how it relates to the primary source.

**Tensions or Surprises**
1–2 sentences ONLY if there are genuine contradictions or non-obvious connections. Skip this section entirely if nothing is surprising — do not force it.

**Synthesis**
1–2 sentences: one takeaway that only emerges from seeing "${primaryTitle}" in the context of the broader graph. The "zoom out" moment.

RULES:
- Do NOT give a breakdown of each related source individually — no source-by-source summaries.
- Related sources exist only to illuminate "${primaryTitle}" — they are supporting cast, not co-stars.
- Be specific: cite entity names and relationship types, not vague thematic language.
- If a section would be empty or forced, skip it.`,
    queryConfig: { mindset: 'comparative', toolMode: 'deep' },
    scope: { sourceIds: allIds, mode: 'hard' },
    entryPoint: 'home_source_compare',
    displayLabel: `Insights: ${primaryTitle} + ${relatedSources.length} sources`,
  }
}

// ─── Explore: Entity Browser (§3.7) ─────────────────────────────────────────

export function buildBrowseEntityExploreContext(entity: {
  id: string; label: string; entity_type: string; source_id?: string | null
}): ChatEntryContext {
  return {
    autoQuery: `Tell me about "${entity.label}" and its connections in my knowledge graph.`,
    systemDirective: `The user selected this entity from the Explore browser. They want an overview of what this entity represents, its key relationships, and what sources mention it. Prioritise breadth — surface the most important connections and let the user drill deeper with follow-ups.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: {
      entityIds: [entity.id],
      sourceIds: entity.source_id ? [entity.source_id] : undefined,
      mode: 'soft',
    },
    entryPoint: 'explore_entity_browse',
    displayLabel: `Exploring: ${entity.label}`,
    metadata: { entityType: entity.entity_type },
  }
}

// ─── Explore: Source Connection (§3.8) ──────────────────────────────────────

export function buildSourceConnectionContext(params: {
  sourceA: { id: string; title: string }
  sourceB: { id: string; title: string }
  connectionPrompt: string
}): ChatEntryContext {
  return {
    autoQuery: params.connectionPrompt,
    systemDirective: `The user is exploring the connection between two sources in the Source Graph view. They can see the source titles, connection types, and shared entities. Go deeper into: (1) the significance of the shared entities or themes between these sources, (2) what each source adds that the other does not, (3) whether the connection reveals a pattern or insight the user might not have noticed. Keep the analysis grounded in the source material.`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: { sourceIds: [params.sourceA.id, params.sourceB.id], mode: 'soft' },
    entryPoint: 'explore_source_connection',
    displayLabel: `Connection: ${params.sourceA.title} ↔ ${params.sourceB.title}`,
  }
}

// ─── Explore: NodeDetailPanel (§3.9) ────────────────────────────────────────

export function buildNodeDetailExploreContext(node: KnowledgeNode): ChatEntryContext {
  return {
    autoQuery: `Tell me about "${node.label}" (${node.entity_type}). What is its significance in my knowledge graph, what key insights are associated with it, and how does it connect to other important concepts?`,
    systemDirective: `The user is exploring a single entity from their Home feed. They can already see its label, type, confidence score, and description — do not repeat these. Focus on: (1) what multiple sources say about this entity and any differences between them, (2) its most significant relationships to other entities and why those relationships matter, (3) any patterns or themes that emerge from its connections. If this is an Anchor, emphasise its role as a connective hub across sources.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: {
      entityIds: [node.id],
      sourceIds: node.source_id ? [node.source_id] : undefined,
      mode: 'soft',
    },
    entryPoint: 'explore_entity_graph',
    displayLabel: `Exploring: ${node.label}`,
    metadata: { entityType: node.entity_type },
  }
}

// ─── Explore: Anchor Connections (Landscape View) ───────────────────────────

export function buildAnchorConnectionsContext(params: {
  anchorId: string
  anchorLabel: string
  entityType: string
  description: string | null
  entityCount: number
  connectedAnchors: { label: string; entityType: string; sharedEntityCount: number; crossEdgeCount: number }[]
}): ChatEntryContext {
  const topConnections = params.connectedAnchors.slice(0, 8)
  const connectionSummary = topConnections.length > 0
    ? topConnections.map((c, i) =>
        `${i + 1}. "${c.label}" (${c.entityType}) — ${c.sharedEntityCount} shared entities, ${c.crossEdgeCount} cross-edges`
      ).join('\n')
    : 'No cross-cluster connections found.'

  return {
    autoQuery: `How does "${params.anchorLabel}" connect to the other major topics in my knowledge graph? What are the most significant relationships, shared themes, and bridging concepts between this anchor and its top connections?`,
    systemDirective: `CONTEXT: The user is viewing the anchor "${params.anchorLabel}" (${params.entityType}) in the landscape view of their knowledge graph. This anchor contains ${params.entityCount} entities and is connected to ${params.connectedAnchors.length} other anchors.${params.description ? `\n\nAnchor description: ${params.description}` : ''}

TOP ${topConnections.length} CONNECTIONS (ranked by strength):
${connectionSummary}

INSTRUCTIONS:
- For each of the top connections listed above, explain WHY these anchors are connected — what shared entities, themes, or source material bridges them.
- Identify the most SIGNIFICANT connection and explain its implications — what does this relationship reveal about the user's knowledge landscape?
- Surface any SURPRISING or non-obvious connections that the user might not expect.
- Note any CLUSTERS or PATTERNS — are there groups of anchors that form a natural thematic cluster?
- If any connections seem WEAK or potentially spurious, flag them briefly.
- End with 1-2 insights about the anchor's ROLE in the broader knowledge graph — is it a central hub, a bridge between domains, or a specialist topic?
- Be specific — cite entity names, relationship types, and source titles where possible.
- Structure as: Overview of connectivity → Top connections with analysis → Patterns and clusters → Role and significance.`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: { anchorIds: [params.anchorId], mode: 'soft' },
    entryPoint: 'explore_anchor_connections',
    displayLabel: `Connections: ${params.anchorLabel}`,
    metadata: { entityType: params.entityType },
  }
}

// ─── Capture: Post-Extraction (§3.10) ───────────────────────────────────────

export function buildPostExtractionContext(params: {
  sourceId: string
  sourceTitle: string
  sourceType: string
  entityCount: number
  relationshipCount: number
}): ChatEntryContext {
  const title = params.sourceTitle || 'Untitled Source'
  return {
    autoQuery: `I just ingested "${title}" (${params.sourceType}). It produced ${params.entityCount} entities and ${params.relationshipCount} relationships. What are the most important things it contains, and how does it connect to what I already know?`,
    systemDirective: `The user just completed an extraction and wants to understand what they captured. This is their first interaction with this source — make it count. Focus on: (1) the most substantive entities and relationships that were extracted, (2) how this new content connects to the user's existing knowledge graph (cross-connections), (3) any gaps or areas where the extraction may have missed important details. Be specific about entity names, relationship types, and source content. The user values depth and specificity.`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: { sourceIds: [params.sourceId], mode: 'hard' },
    entryPoint: 'capture_post_extraction',
    displayLabel: `Just captured: ${title}`,
  }
}

// ─── Pipeline: Extraction Detail (§3.11) ────────────────────────────────────

export function buildExtractionDetailContext(params: {
  sourceId: string
  title: string
  sourceType: string
  entityCount: number
}): ChatEntryContext {
  const title = params.title || 'Untitled Source'
  return {
    autoQuery: `Tell me about "${title}". This ${params.sourceType} produced ${params.entityCount} entities. What are the key insights, and how does it connect to the rest of my knowledge?`,
    systemDirective: `The user is reviewing a past extraction in the Pipeline view. They can see the entity count, relationship count, and confidence score. Give them a substantive analysis of what this source contains and how it fits into their broader knowledge graph. Highlight cross-connections to other sources and any surprising or high-value entities.`,
    queryConfig: { mindset: 'factual', toolMode: 'quick' },
    scope: { sourceIds: [params.sourceId], mode: 'hard' },
    entryPoint: 'pipeline_extraction_detail',
    displayLabel: `Extraction: ${title}`,
  }
}

// ─── Orient: Digest Drilldown (§3.12) ───────────────────────────────────────

export function buildDigestDrilldownContext(params: {
  profileTitle: string
  executiveSummary: string
  moduleTitles: string[]
  frequency?: string
}): ChatEntryContext {
  const freq = params.frequency ?? 'recent'
  return {
    autoQuery: `Based on my ${freq} digest "${params.profileTitle}", dig deeper into the key themes. The executive summary is: "${params.executiveSummary}". What additional context, connections, and implications should I be aware of?`,
    systemDirective: `The user has read a digest briefing and wants to go deeper. The digest was auto-generated from their knowledge graph. Do not repeat the executive summary — they have already read it. Instead: (1) expand on the most important points with specific evidence from source material, (2) surface connections between the digest themes that the briefing did not cover, (3) identify any contradictions, open questions, or gaps in the user's knowledge on these topics. Treat this as a senior advisor following up on a briefing.`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    entryPoint: 'orient_digest_drilldown',
    displayLabel: `Briefing: ${params.profileTitle}`,
  }
}

// ─── Anchors: Explore Anchor (§3.13) ────────────────────────────────────────

export function buildAnchorExploreContext(params: {
  nodeId: string
  label: string
  entityType: string
  description: string | null
}): ChatEntryContext {
  return {
    autoQuery: `Explore the anchor topic "${params.label}" (${params.entityType}). What are the most important entities, sources, and themes connected to it? How central is it to my knowledge graph?`,
    systemDirective: `The user is evaluating an anchor candidate in the Anchors view. They can see the node's label, type, description, and signal scores (centrality, diversity, velocity, richness). Help them understand: (1) what makes this topic significant as a potential anchor — what sources feed into it and what themes it connects, (2) what the anchor's neighbourhood looks like — its most important connected entities and relationships, (3) whether it overlaps with existing anchors or fills a gap. The user is deciding whether to promote this entity to anchor status, so provide evidence that helps them make that judgment.`,
    queryConfig: { mindset: 'exploratory', toolMode: 'deep' },
    scope: { entityIds: [params.nodeId], mode: 'soft' },
    entryPoint: 'anchors_explore',
    displayLabel: `Anchor: ${params.label}`,
    metadata: { entityType: params.entityType },
  }
}

// ─── Council: Insight Chat (§3.14) ─────────────────────────────────────────

export function buildInsightChatContext(insight: AgentInsightRow, agentName?: string): ChatEntryContext {
  const agent = agentName ?? 'an advisor'
  return {
    autoQuery: `One of my advisors surfaced this insight: "${insight.claim}". Dig deeper — what evidence supports this, what are the implications, and should I act on it?`,
    systemDirective: `The user is exploring an insight generated by their Advisory Council. The insight was surfaced by the "${agent}" advisor and is classified as a "${insight.insight_type}" (tension = conflicting evidence, convergence = multiple sources corroborating, novel_connection = unexpected link between concepts).

Evidence summary: ${insight.evidence_summary ?? 'None provided'}
Confidence: ${insight.confidence ?? 'Unknown'}
Related entities: ${insight.related_entity_ids?.length ?? 0}
Related sources: ${insight.related_source_ids?.length ?? 0}

Focus on: (1) what specific source material and entities support or contradict this insight, (2) whether the insight reveals a gap, opportunity, or risk in the user's knowledge, (3) what follow-up questions or actions would help resolve or deepen this insight. If it's a tension, present both sides fairly. If it's a convergence, assess how strong the corroboration is. If it's a novel connection, explain why the link is significant.`,
    queryConfig: { mindset: 'analytical', toolMode: 'deep' },
    scope: {
      sourceIds: insight.related_source_ids?.length ? insight.related_source_ids : undefined,
      entityIds: insight.related_entity_ids?.length ? insight.related_entity_ids : undefined,
      mode: 'soft',
    },
    entryPoint: 'council_insight_chat',
    displayLabel: `Insight: ${insight.claim.slice(0, 60)}${insight.claim.length > 60 ? '…' : ''}`,
  }
}

// ─── Council: Skill Chat (§3.16) ───────────────────────────────────────────

export function buildSkillChatContext(skill: {
  id: string
  name: string
  title: string
  description: string
  source_count: number
  agent_name: string | null
}): ChatEntryContext {
  const label = skill.title || skill.name
  return {
    autoQuery: `Tell me about the skill "${label}". What does it cover, how was it built from my sources, and how can I apply it?`,
    systemDirective: `The user is exploring a knowledge skill from their graph. Skills are synthesised capabilities extracted from multiple sources — they represent reusable knowledge the user has accumulated.

Skill: ${label}
Description: ${skill.description}
Sources: ${skill.source_count}
${skill.agent_name ? `Related advisor: ${skill.agent_name}` : ''}

Focus on: (1) what specific knowledge this skill encapsulates — the key concepts, techniques, or frameworks it contains, (2) how it was built — which sources contributed and what they each added, (3) practical applications — how the user could apply this skill in their work, (4) gaps or areas where the skill could be strengthened with additional content. Be concrete and actionable.`,
    queryConfig: { mindset: 'factual', toolMode: 'deep' },
    entryPoint: 'council_skill_chat',
    displayLabel: `Skill: ${label}`,
  }
}
