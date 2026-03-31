/**
 * PRD-C: Per-entry-point and per-intent response format instruction strings.
 *
 * These are injected into the Gemini system prompt between the system directive
 * (PRD-A) and the answering rules, telling the model HOW to structure its output.
 *
 * Each format includes a concrete example of the expected JSON output so the model
 * follows the structure consistently across all query types.
 */

export const RESPONSE_FORMATS: Record<string, string> = {

  source_chat: `## Response Structure
Organise your response by themes found in this source (2-4 themes). For each theme, use a **bold heading** and provide specific quotes, data points, decisions, and names -- the detail that a summary strips out. End with a brief "Connections to your graph" section (2-3 sentences) linking this source's themes to entities in other sources. Do not include an introductory preamble -- dive straight into the first theme.

## Example Output
{
  "answer": "**Strategic Direction and Market Positioning**\\nThe core discussion centred on defining the product's competitive moat. **Sarah Chen** argued that the current document-layer approach may not be sufficient for differentiation [1]. She specifically noted that competitors like **Credo AI** have already captured the compliance automation segment [1].\\n\\n**Technical Architecture Decisions**\\nThe team evaluated three ingestion approaches: behavioral monitoring, artifact scanning, and documentary capture [2]. **James Park** recommended prioritising the behavioral layer first, citing customer feedback that real-time visibility is the top unmet need [2].\\n\\n**Connections to your graph**\\nThese strategic decisions connect directly to the **Product Roadmap** entity and the ongoing **Series B preparation** tracked in other meeting notes.",
  "citations": [
    {"index": 1, "label": "Q4 Strategy Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Q4 Strategy Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 3}
  ],
  "followUp": {"question": "What specific competitor capabilities were discussed and how does our approach differ?", "label": "Competitor deep-dive"}
}`,

  source_compare: `## Response Structure
Open with one sentence framing what these two sources have in common. Then organise by shared themes (2-3). For each theme, use a **bold heading** followed by two clearly attributed paragraphs: "In **{Source A title}**..." and "In **{Source B title}**...". After the themes, add a **"Unique to each"** section noting what one source covers that the other does not. Close with a **"Synthesis"** paragraph: "Together, these sources tell you..." Keep attribution clear throughout -- never blend which source said what.

## Example Output
{
  "answer": "Both sources address the challenge of scaling AI adoption within enterprise organisations, though from different angles.\\n\\n**Training Methodology**\\nIn **AI Upskilling Workshop Notes**, the focus is on hands-on learning through structured exercises, with **Maria Lopez** emphasising that participants need to build real prompts during the session [1]. In **Digital Skill Assessment Report**, the approach is assessment-driven, recommending that organisations map existing skill gaps before designing training [2].\\n\\n**Unique to each**\\nThe Workshop Notes uniquely cover facilitation techniques and group dynamics [1]. The Assessment Report uniquely provides a scoring rubric for measuring AI readiness [2].\\n\\n**Synthesis**\\nTogether, these sources tell you that effective AI upskilling requires both a diagnostic phase (understanding where people are) and an experiential phase (hands-on practice).",
  "citations": [
    {"index": 1, "label": "AI Upskilling Workshop Notes", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Digital Skill Assessment Report", "entity_type": "Document", "node_id": null, "source_id": "def-456", "chunk_index": 0}
  ],
  "followUp": {"question": "Which specific skill gaps were identified and how do the workshop exercises address them?", "label": "Skill gaps detail"}
}`,

  entity_explore: `## Response Structure
Lead with what this entity is and why it matters -- one strong paragraph. Then cover **Key Relationships** (the 3-5 most significant connections, each as a short paragraph). Then **Across Sources** (where this entity appears and whether it means different things in different contexts). End with **Open Threads** (anything unresolved, contradicted, or worth exploring further).

## Example Output
{
  "answer": "**Joseph Thomas** is a workstream lead at **OXYGY**, responsible for the AI upskilling initiative and a key contributor to the **AI Centre of Excellence** [1] [3]. He operates at the intersection of strategy and implementation, translating high-level AI adoption goals into concrete training programs.\\n\\n**Key Relationships**\\n**Marisha Boyd** is his primary collaborator on the upskilling platform, co-developing the curriculum and feedback loops [2]. He reports into the **AI CoE governance structure** and has direct influence on vendor selection decisions [3].\\n\\n**Across Sources**\\nIn meeting transcripts, Joseph appears as a decision-maker driving timelines [1]. In the platform feedback documents, he appears as a hands-on developer testing features [4]. This dual role suggests he bridges strategic planning and technical execution.\\n\\n**Open Threads**\\nSeveral sources reference a pending decision on whether the platform will be deployed internally first or offered to clients [3] [4].",
  "citations": [
    {"index": 1, "label": "AI CoE Planning Session", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Platform Development Sync", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "AI Strategy Document", "entity_type": "Document", "node_id": null, "source_id": "ghi-789", "chunk_index": 0},
    {"index": 4, "label": "Upskilling Platform Feedback", "entity_type": "Meeting", "node_id": null, "source_id": "jkl-012", "chunk_index": 2}
  ],
  "followUp": {"question": "What specific decisions has Joseph made about the platform's direction?", "label": "Platform decisions"}
}`,

  entity_similar: `## Response Structure
Brief intro: "Based on {entity}'s profile, here are the most related entities in your graph." Then a **numbered list** (5-8 items). Each item: **bold label** (Entity Type), then 1-2 sentences explaining *why* it is similar (shared sources, shared connections, semantic overlap, same tags). End with one **"Surprise connection"** -- a non-obvious match with a brief explanation of why it is unexpected.

## Example Output
{
  "answer": "Based on **AI Upskilling Platform**'s profile, here are the most related entities in your graph:\\n\\n1. **Digital Learning Hub** (Product) — Both are interactive training platforms focused on AI skill development, appearing together in 4 sources [1].\\n2. **Prompt Engineering Workshop** (Event) — Shares the same target audience and learning methodology as the upskilling platform [2].\\n3. **OXYGY Academy** (Organization) — The parent initiative housing both the platform and related training programs [1] [3].\\n\\n**Surprise connection**\\n**Customer Survey Tool** (Product) — Not obviously related, but the survey tool's AI-powered analysis features were originally prototyped as a Level 3 exercise within the upskilling platform [4].",
  "citations": [
    {"index": 1, "label": "Platform Overview Doc", "entity_type": "Document", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Workshop Notes", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "OXYGY Strategy Brief", "entity_type": "Document", "node_id": null, "source_id": "ghi-789", "chunk_index": 0},
    {"index": 4, "label": "Sprint Retro", "entity_type": "Meeting", "node_id": null, "source_id": "jkl-012", "chunk_index": 3}
  ]
}`,

  relationship_chat: `## Response Structure
Do not restate the relationship -- the user can see it. Start with **Evidence**: what source material supports this connection, with specific quotes or details. Then **Implications**: what this relationship enables, risks, or means for the broader picture. Then **Cross-Source Perspective**: if different sources have different takes on this relationship, surface that. Keep the response focused and shorter than a typical answer -- this is a targeted question.

## Example Output
{
  "answer": "**Evidence**\\nIn the Q3 planning session, **Sarah** explicitly stated that the ingestion layer choice 'will define our customer segment and which features are even relevant' [1]. The technical spec document reinforces this by listing three ingestion approaches, each tied to different compliance use cases [2].\\n\\n**Implications**\\nThis relationship means the ingestion architecture is not just a technical decision -- it is a market positioning decision. Choosing behavioral monitoring targets real-time compliance teams; choosing documentary capture targets legal and procurement teams [2].\\n\\n**Cross-Source Perspective**\\nThe planning session treats this as an urgent either/or decision [1], while the technical spec suggests a phased approach is possible [2]. These perspectives are not contradictory but suggest different timelines.",
  "citations": [
    {"index": 1, "label": "Q3 Planning Session", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 2},
    {"index": 2, "label": "Technical Architecture Spec", "entity_type": "Document", "node_id": null, "source_id": "def-456", "chunk_index": 0}
  ]
}`,

  source_anchor: `## Response Structure
Lead with one sentence on the anchor's significance. Then **What this source contributes**: 2-3 specific things this source adds to the user's understanding of the anchor topic. Then **Compared to other sources**: what other anchor-connected sources say, and whether this source agrees, extends, or challenges them. Then **Bridge entities**: which extracted entities from this source link to the anchor and through what relationships. Frame the overall answer as: "Here is what this source contributes to your understanding of {anchor}."

## Example Output
{
  "answer": "**AI Governance** is one of your most connected anchors, appearing across 12 sources with 34 entity connections.\\n\\n**What this source contributes**\\nThis meeting transcript adds three specific insights: (1) the team agreed that governance must be 'embedded in the workflow, not bolted on after' [1], (2) **CompL AI** was identified as the leading open-source framework for EU AI Act compliance [1], and (3) a decision was made to prioritise the SAP integration pathway [2].\\n\\n**Compared to other sources**\\nThe strategy document from last month positioned governance as primarily a risk mitigation concern [3]. This source shifts the framing toward governance as a competitive advantage -- a notable evolution in thinking.\\n\\n**Bridge entities**\\n**CompL AI** (Technology) connects to the anchor through a 'supports' relationship. **EU AI Act** (Regulation) connects through 'relates_to' [1].",
  "citations": [
    {"index": 1, "label": "Governance Review Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Governance Review Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 4},
    {"index": 3, "label": "AI Strategy Document", "entity_type": "Document", "node_id": null, "source_id": "def-456", "chunk_index": 1}
  ],
  "followUp": {"question": "How does the SAP integration pathway connect to the broader AI governance strategy?", "label": "SAP integration"}
}`,

  post_extraction: `## Response Structure
Start with **What you captured**: the 3-5 most substantive entities with their types and brief descriptions. Then **Key relationships**: the most interesting connections that were extracted. Then **Cross-connections**: how this new content links to existing knowledge (this is the high-value moment). End with **What might be missing**: a gentle suggestion of what the extraction may have overlooked. Use a conversational, warm tone -- this is a moment of satisfaction.

## Example Output
{
  "answer": "**What you captured**\\nGreat content here. The extraction identified **AI Readiness Assessment** (Tool) -- the scoring framework discussed in detail [1]. Also captured **Phoebe** (Person) as a key facilitator and **Level 3 Certification** (Goal) as the target outcome [1] [2].\\n\\n**Key relationships**\\n**Phoebe** → leads → **AI Readiness Assessment** and **Level 3 Certification** → enables → **Client Deployment** form an interesting chain showing the path from assessment to real-world application [1] [2].\\n\\n**Cross-connections**\\nThis connects beautifully to your existing knowledge: **AI Readiness Assessment** links to the **Digital Skills Framework** entity from your OXYGY strategy documents. The assessment approach described here may be a practical implementation of that framework [2].\\n\\n**What might be missing**\\nThe discussion mentioned specific scoring criteria (1-5 scale for each dimension) but the extraction may not have captured the individual dimensions as separate entities. Worth re-extracting if you need that granularity.",
  "citations": [
    {"index": 1, "label": "Upskilling Workshop Recording", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Upskilling Workshop Recording", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 3}
  ],
  "followUp": {"question": "What specific dimensions does the AI Readiness Assessment score on?", "label": "Assessment dimensions"}
}`,

  digest_drilldown: `## Response Structure
Do not repeat the executive summary. Expand on the 2-3 biggest themes: for each, give the full story -- what sources support it, what entities are involved, what the nuance is. Then **Connections the digest missed**: cross-connections between themes that the briefing did not surface. End with **Open questions**: things the digest flagged but did not resolve.

## Example Output
{
  "answer": "**Theme 1: Platform Readiness Concerns**\\nThree separate sources this week raised concerns about the platform's readiness for client deployment. In the **Sprint Retro**, the team identified 4 blocking bugs in the assessment module [1]. In the **Client Demo Prep** meeting, **Marisha** flagged that the onboarding flow confuses first-time users [2]. The **Usability Test** with **Yuji** confirmed navigation issues [3].\\n\\n**Connections the digest missed**\\nThe sprint bugs [1] and the usability issues [3] are likely symptoms of the same root cause -- the assessment module was rebuilt from scratch in the last sprint without sufficient testing. The digest treated these as separate items.\\n\\n**Open questions**\\nShould the client demo be postponed until the blocking bugs are resolved? **Marisha**'s meeting notes suggest she is considering this but no decision was recorded [2].",
  "citations": [
    {"index": 1, "label": "Sprint Retro", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 1},
    {"index": 2, "label": "Client Demo Prep", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 0},
    {"index": 3, "label": "Usability Test Notes", "entity_type": "Document", "node_id": null, "source_id": "ghi-789", "chunk_index": 2}
  ],
  "followUp": {"question": "What are the specific blocking bugs and their current status?", "label": "Bug details"}
}`,

  anchor_explore: `## Response Structure
Start with a **Hub summary**: what this anchor represents and how central it is. Then **Top connected entities** (5-8), grouped by type (People, Projects, Decisions, etc.). Then **Source coverage**: which sources feed into this anchor and what each contributes. End with **Trajectory**: is this anchor gaining new connections over time or static?

## Example Output
{
  "answer": "**Hub Summary**\\n**AI Upskilling** is one of your most active anchors with 45 connected entities across 18 sources. It represents the company's initiative to train employees and clients on practical AI skills [1] [5].\\n\\n**Top Connected Entities**\\n*People:* **Joseph Thomas** (workstream lead), **Marisha Boyd** (co-developer), **Yuji Develle** (usability tester) [1] [2] [3].\\n*Projects:* **Upskilling Platform** (the interactive learning site), **AI Readiness Assessment** (the scoring tool) [1] [4].\\n*Decisions:* **Five-level framework** (the learning progression structure), **Cohort-based deployment** (delivery model) [5].\\n\\n**Source Coverage**\\n18 sources reference this anchor. Meeting transcripts provide the richest detail (12 sources), followed by documents (4) and YouTube content (2) [1-5].\\n\\n**Trajectory**\\nThis anchor has gained 8 new entity connections in the last 2 weeks, suggesting it is actively growing. Most new connections relate to the feedback and iteration cycle.",
  "citations": [
    {"index": 1, "label": "AI CoE Planning", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Platform Dev Sync", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "Usability Test", "entity_type": "Document", "node_id": null, "source_id": "ghi-789", "chunk_index": 0},
    {"index": 4, "label": "Assessment Design Doc", "entity_type": "Document", "node_id": null, "source_id": "jkl-012", "chunk_index": 0},
    {"index": 5, "label": "Strategy Brief", "entity_type": "Document", "node_id": null, "source_id": "mno-345", "chunk_index": 2}
  ],
  "followUp": {"question": "Which sources have the most cross-connections to other anchors?", "label": "Cross-anchor links"}
}`,

  auto_prose: `## Response Structure
Write in clear flowing prose. Use **bold** for people's names, key terms, and important facts. Use natural paragraph breaks. Lead with the most important finding, then supporting evidence, then implications or open questions.

## Example Output
{
  "answer": "The most significant development across your recent knowledge is the convergence of **AI governance** and **upskilling** initiatives [1] [3]. **Joseph Thomas** has been driving both workstreams, and recent meeting notes suggest they are becoming increasingly interconnected [1].\\n\\nSpecifically, the **AI Readiness Assessment** tool developed for the upskilling platform is now being considered as a governance compliance checkpoint [2]. This was first proposed by **Sarah Chen** during the Q3 review and has since gained support from the leadership team [3].\\n\\nThe open question is whether this convergence is intentional strategy or organic evolution. The evidence suggests the latter -- no single document articulates a unified vision, but the connections are forming naturally through shared team members and overlapping goals [1] [2] [3].",
  "citations": [
    {"index": 1, "label": "AI CoE Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Assessment Design", "entity_type": "Document", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "Q3 Strategy Review", "entity_type": "Meeting", "node_id": null, "source_id": "ghi-789", "chunk_index": 0}
  ],
  "followUp": {"question": "What specific governance requirements could the assessment tool address?", "label": "Governance fit"}
}`,

  auto_list: `## Response Structure
Brief intro (1-2 sentences), then a **numbered list** with each item as a bold label followed by 1-2 sentences of explanation. End with a brief synthesis.

## Example Output
{
  "answer": "Based on your knowledge graph, here are the key decisions made across recent meetings:\\n\\n1. **Five-level upskilling framework adopted** — The team agreed on a progressive 5-level structure from fundamentals to full application building [1].\\n2. **Cohort-based deployment model** — Rather than self-paced, the platform will be deployed in structured cohorts for accountability [2].\\n3. **SAP partnership prioritised** — The integration with SAP was chosen over competing vendor options for the compliance module [3].\\n4. **Usability testing before launch** — A mandatory round of user testing was scheduled following feedback from **Yuji Develle** [4].\\n\\nThe common thread is a shift from 'build fast' to 'build right' — quality and user experience are now taking priority over speed to market.",
  "citations": [
    {"index": 1, "label": "Framework Design Meeting", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Deployment Planning", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 2},
    {"index": 3, "label": "Vendor Review", "entity_type": "Meeting", "node_id": null, "source_id": "ghi-789", "chunk_index": 1},
    {"index": 4, "label": "Usability Test Notes", "entity_type": "Document", "node_id": null, "source_id": "jkl-012", "chunk_index": 0}
  ],
  "followUp": {"question": "What drove the decision to prioritise the SAP partnership over other vendors?", "label": "SAP decision"}
}`,

  auto_comparison: `## Response Structure
Organise the response as a structured comparison along consistent dimensions. For each dimension, cite the specific evidence supporting each side. End with a synthesis noting the most significant differences or similarities.

## Example Output
{
  "answer": "**Approach to AI Training**\\n**Source A** advocates for hands-on, project-based learning where participants build real tools during sessions [1]. **Source B** recommends starting with assessment and theory before practical application [2].\\n\\n**Target Audience**\\nBoth sources target non-technical professionals, but **Source A** focuses specifically on HR teams [1] while **Source B** addresses a broader cross-functional audience including finance and operations [2].\\n\\n**Synthesis**\\nThe most significant difference is the sequencing: build-first vs assess-first. Both approaches have merit, and the sources suggest they may work best in combination -- assess to understand starting points, then immediately apply through hands-on exercises.",
  "citations": [
    {"index": 1, "label": "Workshop Design Doc", "entity_type": "Document", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Assessment Framework", "entity_type": "Document", "node_id": null, "source_id": "def-456", "chunk_index": 1}
  ]
}`,

  auto_timeline: `## Response Structure
Organise chronologically, oldest to most recent. Each entry: **bold date/period**, then what happened and why it matters. End with a "Current state" paragraph and a forward-looking observation.

## Example Output
{
  "answer": "**Early March 2026** — The AI upskilling initiative was formally approved by leadership, with **Joseph Thomas** and **Marisha Boyd** assigned as co-leads [1].\\n\\n**Mid-March 2026** — The five-level learning framework was designed and the interactive platform development began. First prototype completed within two weeks [2].\\n\\n**Late March 2026** — Usability testing conducted with **Yuji Develle**, **Cristina Valle de Vicente**, and **Zoe Zhang**. Key feedback included navigation confusion and the need for transparency in learning path generation [3] [4].\\n\\n**Current state** — The platform is functional but undergoing iteration based on user feedback. A client demo is pending but may be delayed until blocking issues are resolved [4].\\n\\nLooking ahead, the next milestone appears to be resolving the usability issues and conducting a second round of testing before any external deployment.",
  "citations": [
    {"index": 1, "label": "AI CoE Kickoff", "entity_type": "Meeting", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Sprint Review", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "Usability Test - Yuji", "entity_type": "Document", "node_id": null, "source_id": "ghi-789", "chunk_index": 0},
    {"index": 4, "label": "Feedback Summary", "entity_type": "Meeting", "node_id": null, "source_id": "jkl-012", "chunk_index": 2}
  ],
  "followUp": {"question": "What specific blocking issues need to be resolved before the client demo?", "label": "Blocking issues"}
}`,

  auto_summary: `## Response Structure
Provide a concise overview in 3-5 paragraphs. Lead with the core answer, follow with key supporting details, end with context or caveats. Keep it shorter than a typical analytical response.

## Example Output
{
  "answer": "The AI upskilling initiative at **OXYGY** is a custom-built interactive learning platform targeting non-technical professionals who need to apply AI in their daily work [1]. It uses a five-level progressive framework, from fundamentals to full application building [2].\\n\\nThe platform has been built rapidly over approximately two weeks by **Joseph Thomas** and **Marisha Boyd**, using AI coding tools including **Claude Code** and **Cursor** [1]. Early usability testing has revealed navigation and transparency concerns that are being actively addressed [3].\\n\\nThe initiative serves a dual purpose: internal capability building and potential client-facing deployment as part of OXYGY's consulting offerings [2]. However, the timeline for external deployment remains dependent on resolving current usability feedback.",
  "citations": [
    {"index": 1, "label": "Platform Overview", "entity_type": "Document", "node_id": null, "source_id": "abc-123", "chunk_index": 0},
    {"index": 2, "label": "Framework Design", "entity_type": "Meeting", "node_id": null, "source_id": "def-456", "chunk_index": 1},
    {"index": 3, "label": "Usability Feedback", "entity_type": "Meeting", "node_id": null, "source_id": "ghi-789", "chunk_index": 0}
  ]
}`,
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
