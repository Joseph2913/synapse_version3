/**
 * PRD-C: Per-entry-point and per-intent response format instruction strings.
 *
 * These are injected into the Gemini system prompt between the system directive
 * (PRD-A) and the answering rules, telling the model HOW to structure its output.
 */

export const RESPONSE_FORMATS: Record<string, string> = {

  source_chat: `## Response Structure
Organise your response by themes found in this source (2-4 themes). For each theme, use a **bold heading** and provide specific quotes, data points, decisions, and names -- the detail that a summary strips out. End with a brief "Connections to your graph" section (2-3 sentences) linking this source's themes to entities in other sources. Do not include an introductory preamble -- dive straight into the first theme.`,

  source_compare: `## Response Structure
Open with one sentence framing what these two sources have in common. Then organise by shared themes (2-3). For each theme, use a **bold heading** followed by two clearly attributed paragraphs: "In **{Source A title}**..." and "In **{Source B title}**...". After the themes, add a **"Unique to each"** section noting what one source covers that the other does not. Close with a **"Synthesis"** paragraph: "Together, these sources tell you..." Keep attribution clear throughout -- never blend which source said what.`,

  entity_explore: `## Response Structure
Lead with what this entity is and why it matters -- one strong paragraph. Then cover **Key Relationships** (the 3-5 most significant connections, each as a short paragraph). Then **Across Sources** (where this entity appears and whether it means different things in different contexts). End with **Open Threads** (anything unresolved, contradicted, or worth exploring further).`,

  entity_similar: `## Response Structure
Brief intro: "Based on {entity}'s profile, here are the most related entities in your graph." Then a **numbered list** (5-8 items). Each item: **bold label** (Entity Type), then 1-2 sentences explaining *why* it is similar (shared sources, shared connections, semantic overlap, same tags). End with one **"Surprise connection"** -- a non-obvious match with a brief explanation of why it is unexpected.`,

  relationship_chat: `## Response Structure
Do not restate the relationship -- the user can see it. Start with **Evidence**: what source material supports this connection, with specific quotes or details. Then **Implications**: what this relationship enables, risks, or means for the broader picture. Then **Cross-Source Perspective**: if different sources have different takes on this relationship, surface that. Keep the response focused and shorter than a typical answer -- this is a targeted question.`,

  source_anchor: `## Response Structure
Lead with one sentence on the anchor's significance. Then **What this source contributes**: 2-3 specific things this source adds to the user's understanding of the anchor topic. Then **Compared to other sources**: what other anchor-connected sources say, and whether this source agrees, extends, or challenges them. Then **Bridge entities**: which extracted entities from this source link to the anchor and through what relationships. Frame the overall answer as: "Here is what this source contributes to your understanding of {anchor}."`,

  post_extraction: `## Response Structure
Start with **What you captured**: the 3-5 most substantive entities with their types and brief descriptions. Then **Key relationships**: the most interesting connections that were extracted. Then **Cross-connections**: how this new content links to existing knowledge (this is the high-value moment). End with **What might be missing**: a gentle suggestion of what the extraction may have overlooked. Use a conversational, warm tone -- this is a moment of satisfaction.`,

  digest_drilldown: `## Response Structure
Do not repeat the executive summary. Expand on the 2-3 biggest themes: for each, give the full story -- what sources support it, what entities are involved, what the nuance is. Then **Connections the digest missed**: cross-connections between themes that the briefing did not surface. End with **Open questions**: things the digest flagged but did not resolve.`,

  anchor_explore: `## Response Structure
Start with a **Hub summary**: what this anchor represents and how central it is. Then **Top connected entities** (5-8), grouped by type (People, Projects, Decisions, etc.). Then **Source coverage**: which sources feed into this anchor and what each contributes. End with **Trajectory**: is this anchor gaining new connections over time or static?`,

  auto_prose: `## Response Structure
Write in clear flowing prose. Use **bold** for people's names, key terms, and important facts. Use natural paragraph breaks. Lead with the most important finding, then supporting evidence, then implications or open questions.`,

  auto_list: `## Response Structure
Brief intro (1-2 sentences), then a **numbered list** with each item as a bold label followed by 1-2 sentences of explanation. End with a brief synthesis.`,

  auto_comparison: `## Response Structure
Organise the response as a structured comparison along consistent dimensions. For each dimension, cite the specific evidence supporting each side. End with a synthesis noting the most significant differences or similarities.`,

  auto_timeline: `## Response Structure
Organise chronologically, oldest to most recent. Each entry: **bold date/period**, then what happened and why it matters. End with a "Current state" paragraph and a forward-looking observation.`,

  auto_summary: `## Response Structure
Provide a concise overview in 3-5 paragraphs. Lead with the core answer, follow with key supporting details, end with context or caveats. Keep it shorter than a typical analytical response.`,
}

/**
 * Maps entry point types to their response format key.
 */
import type { ChatEntryPoint } from '../types/chatRouting'

const ENTRY_POINT_FORMAT_MAP: Partial<Record<ChatEntryPoint, string>> = {
  home_source_chat: 'source_chat',
  home_source_compare: 'source_compare',
  home_entity_explore: 'entity_explore',
  explore_entity_browse: 'entity_explore',
  explore_entity_graph: 'entity_explore',
  anchors_explore: 'anchor_explore',
  home_entity_similar: 'entity_similar',
  entity_find_similar: 'entity_similar',
  home_relationship_chat: 'relationship_chat',
  relationship_chat: 'relationship_chat',
  home_source_anchor: 'source_anchor',
  source_anchor_relate: 'source_anchor',
  capture_post_extraction: 'post_extraction',
  pipeline_extraction_detail: 'source_chat',
  orient_digest_drilldown: 'digest_drilldown',
  entity_explore: 'entity_explore',
  explore_node_detail: 'entity_explore',
  source_chat: 'source_chat',
  source_compare: 'source_compare',
  explore_source_connection: 'source_compare',
  explore_anchor_connections: 'anchor_explore',
}

/**
 * Maps auto-classifier responseFormat output to format keys.
 */
const AUTO_FORMAT_MAP: Record<string, string> = {
  prose: 'auto_prose',
  list: 'auto_list',
  comparison: 'auto_comparison',
  timeline: 'auto_timeline',
  summary: 'auto_summary',
}

/**
 * Get the response format instruction string for an entry point.
 */
export function getResponseFormatForEntryPoint(entryPoint: ChatEntryPoint): string | undefined {
  const key = ENTRY_POINT_FORMAT_MAP[entryPoint]
  return key ? RESPONSE_FORMATS[key] : undefined
}

/**
 * Get the response format instruction string for an auto-classified response format.
 */
export function getResponseFormatForClassification(responseFormat: string): string {
  const key = AUTO_FORMAT_MAP[responseFormat] ?? 'auto_prose'
  return RESPONSE_FORMATS[key] ?? RESPONSE_FORMATS['auto_prose'] ?? ''
}

/**
 * Default thinking budgets per entry point (PRD-C §2.3).
 */
const ENTRY_POINT_THINKING_BUDGET: Partial<Record<ChatEntryPoint, number>> = {
  home_source_chat: 1024,
  source_chat: 1024,
  pipeline_extraction_detail: 1024,
  home_source_compare: 8192,
  source_compare: 8192,
  explore_source_connection: 8192,
  home_entity_explore: 4096,
  entity_explore: 4096,
  explore_entity_browse: 4096,
  explore_entity_graph: 4096,
  explore_node_detail: 4096,
  anchors_explore: 4096,
  explore_anchor_connections: 4096,
  home_entity_similar: 0,
  entity_find_similar: 0,
  home_relationship_chat: 1024,
  relationship_chat: 1024,
  home_source_anchor: 4096,
  source_anchor_relate: 4096,
  capture_post_extraction: 4096,
  orient_digest_drilldown: 8192,
}

/**
 * Get the default thinking budget for an entry point.
 */
export function getThinkingBudgetForEntryPoint(entryPoint: ChatEntryPoint): number {
  return ENTRY_POINT_THINKING_BUDGET[entryPoint] ?? 1024
}
