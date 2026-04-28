// ============================================================================
//  api/pipeline/extract-prompt.ts
//
//  Stage 4 — Prompt composition.
//  Single canonical, side-effect-free function that composes the system prompt
//  for entity extraction. Used by both the browser path (src/utils/promptBuilder
//  re-exports from here) and every serverless path that calls runExtractionCore.
//
//  This module deliberately has zero runtime dependencies, no `process.env`
//  reads, and no I/O. That keeps it safe to import from the browser bundle
//  and trivially testable.
//
//  See docs/STAGE-4-PROMPT.md for the contract and docs/EXTRACTION-PROMPT-V2.md
//  for the prompt design rationale.
// ============================================================================

// ─── PROMPT VERSION ─────────────────────────────────────────────────────────
//
// Bump on any structural change to the composed prompt text. Stamped onto
// extraction_sessions.prompt_version so we can correlate extraction quality
// with prompt revisions.
//
//   2.1.0 — 2026-04-28: skills hints section added (Stage 4 unification).
//   2.0.0 — 2026-04-22: v2 XML-tagged prompt with cross-domain examples.
//   1.0.0 — pre-2026-04-22: legacy plain-prose prompt.
//
export const PROMPT_VERSION = '2.1.0';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface PromptUserProfile {
  professional_context?: {
    role?: string | null;
    industry?: string | null;
    current_projects?: string | null;
  } | null;
  personal_interests?: {
    topics?: string | null;
    learning_goals?: string | null;
  } | null;
  processing_preferences?: {
    insight_depth?: string | null;
    relationship_focus?: string | null;
  } | null;
}

export interface PromptAnchor {
  label: string;
  entity_type: string;
  description: string;
  isAuto?: boolean;
}

export interface PromptSkillHint {
  label: string;
  domain?: string | null;
  exposure_level?: string | null;
}

export type ExtractionMode =
  | 'comprehensive'
  | 'strategic'
  | 'actionable'
  | 'relational';

export type AnchorEmphasis = 'passive' | 'standard' | 'aggressive';

export interface PromptConfig {
  mode: ExtractionMode | string;
  anchorEmphasis: AnchorEmphasis | string;
  anchors: PromptAnchor[];
  userProfile: PromptUserProfile | null;
  customInstructions?: string | null;
  /** Confirmed knowledge_skills for the user. Injected as "user expertise" hints. */
  activeSkills?: PromptSkillHint[];
}

export interface ComposedPrompt {
  prompt: string;
  version: string;
}

// ─── MODE + EMPHASIS INSTRUCTIONS ──────────────────────────────────────────

export const MODE_INSTRUCTIONS: Record<ExtractionMode, string> = {
  comprehensive:
    'Extract every entity and relationship that will still be useful to the user six months from now. Target roughly 1 entity per 900 chars of instructional/analytical content and 1 per 600 chars of conversation. Prioritise depth over breadth — a smaller number of high-value entities beats a long list of generic ones. Drop generic single-word nouns (e.g. "Buttons", "Cards", "Text") unless they are the explicit subject of a named framework.',
  strategic:
    'Focus on high-level concepts, strategic decisions, goals, and their interdependencies. Prioritise organisational and directional information.',
  actionable:
    'Emphasise actions, goals, blockers, deadlines, and decisions. Capture what needs to be done, by whom, and any impediments.',
  relational:
    'Prioritise connections and relationships between entities. Emphasise how concepts, people, and organisations relate to each other.',
};

export const EMPHASIS_INSTRUCTIONS: Record<AnchorEmphasis, string> = {
  passive:
    'Treat anchors as low-priority context. Extract them if naturally occurring but do not force anchor-related entities.',
  standard:
    'Give moderate weight to anchor-related content. When content relates to an anchor, extract that connection.',
  aggressive:
    'Heavily weight extraction toward anchor-related content. Actively connect extracted entities back to anchors where plausible.',
};

function modeInstruction(mode: string): string {
  return MODE_INSTRUCTIONS[mode as ExtractionMode] ?? MODE_INSTRUCTIONS.comprehensive;
}

function emphasisInstruction(emphasis: string): string {
  return EMPHASIS_INSTRUCTIONS[emphasis as AnchorEmphasis] ?? EMPHASIS_INSTRUCTIONS.standard;
}

// ─── PROMPT BODY ────────────────────────────────────────────────────────────

const ROLE_BLOCK = `<role>
You are the extraction engine for a personal knowledge graph called Synapse.
You serve users across every domain — technology, finance, marketing, sales,
law, medicine, psychology, education, consulting, science, the arts,
operations, policy. Treat every source as domain-agnostic: you do not know in
advance whether you are reading a legal deposition, an earnings call, a
therapy transcript, a marketing strategy meeting, a physics lecture, or a
software tutorial. Your extraction quality must hold equally across all.

Return every entity and relationship that will still be useful to the user
six months from now, regardless of their field.

This is a PERSONAL knowledge graph, not an encyclopedia:
  - Well-known entities MUST be extracted when mentioned (Fortune 500
    companies, famous academics, landmark legal cases, standard
    methodologies, canonical products). Never skip on grounds of "common
    knowledge."
  - Frameworks, methods, doctrines, models, playbooks, and principles
    INSIDE instructional or analytical content are usually the highest-
    value extraction — more than the people or brands cited as examples.
    A source teaching a named method is incomplete without that method
    AND its sub-components as first-class Concept nodes.
  - Normalise transcript mishearings, OCR artefacts, and auto-caption
    errors to canonical forms. If you cannot confidently infer the
    canonical form, preserve the best phonetic guess AND tag it
    \`needs_review\`.
  - Domain jargon is high-value, not noise: medical codes, legal
    citations, drug names, chemical compounds, financial instruments,
    academic works — all in-scope.
</role>`;

const CONTENT_TYPES_BLOCK = `<content_types>
Detect the content shape first, then adapt priorities. Shapes are
domain-agnostic.
  - Conversation / meeting transcript — prioritise: Person, Organization,
    Decision, Action, Blocker, Risk, Goal, Question. Secondary: Topic,
    Project, Insight, Metric.
  - Instructional / tutorial / lecture — prioritise: Concept (the
    framework or method being taught), Takeaway, Lesson, Person
    (authors/authorities), Organization, Technology, Product, Metric.
    Secondary: Document, Event.
  - Essay / article / analysis / opinion piece — prioritise: Concept,
    Insight, Hypothesis, Takeaway, Person, Organization. Secondary:
    Metric, Document, Technology, Product.
  - Reference / technical / procedural document — prioritise: Concept,
    Technology, Product, Decision, Project, Document. Secondary: Person,
    Metric, Organization.
  - Research / report / data analysis — prioritise: Hypothesis, Insight,
    Metric, Concept, Organization, Document. Secondary: Person, Event,
    Location.
  - Narrative / interview / case study — prioritise: Person, Event,
    Location, Organization, Insight, Lesson, Decision. Secondary:
    Concept, Takeaway.

On any content type, ALWAYS also extract Location (when specific places
are named), Event (when specific events are named), Document (when named
reports/papers/books/specs/statutes/case-law/standards/contracts/URLs are
cited), and Metric (when named numbers/benchmarks/KPIs/ratios are cited).
</content_types>`;

const ENTITY_GUIDE_BLOCK = `<entity_guide>
Use exactly these 24 entity types. When two types could apply, use the
disambiguation rule.
  - Person — a named individual human. Never a company or product.
  - Organization — a company, non-profit, government body, or brand.
  - Team — a named subgroup inside an organisation. If unsure, use Organization.
  - Topic — a broad domain or subject area. Use sparingly; prefer Concept
    for anything more specific than a subject heading.
  - Project — a named, time-bounded piece of work with a goal. Works
    across domains: product launch, legal case, clinical trial, campaign,
    investigation, dissertation, audit.
  - Goal — a stated outcome someone is trying to achieve. Distinct from
    Project: a goal is the outcome, a project is the effort.
  - Action — a specific to-do, next step, or commitment, usually with an
    owner. Most common in meeting content.
  - Risk — a named downside possibility.
  - Blocker — a named impediment blocking progress.
  - Decision — an explicit choice between alternatives (ruling, diagnosis,
    hire, strategy pick, go/no-go).
  - Insight — a non-obvious observation drawn from evidence; usually the
    speaker's own realisation.
  - Question — an explicit open question raised in the content.
  - Idea — a proposed, not-yet-decided direction.
  - Concept — a named framework, mental model, theory, principle, rule,
    doctrine, methodology, technique, or playbook. If the source teaches
    or analyses a named thing, it belongs here.
  - Takeaway — a prescriptive lesson the content argues for. Phrase as
    imperative.
  - Lesson — retrospective learning from a specific past experience.
  - Document — a named report, paper, book, statute, case citation,
    regulation, contract, spec, URL, or artefact. Never for websites-as-
    products (those are Product) or the content itself.
  - Event — a named, time-bounded happening.
  - Location — a specific named place.
  - Technology — a technical approach, method, language, protocol,
    library, algorithm, instrument, or apparatus referenced by name but
    not sold as a branded product.
  - Product — a branded piece of software/hardware/good/service offered
    by an identifiable vendor. Websites-as-services are Product.
  - Metric — a named measurement, benchmark, KPI, ratio, index, rating.
  - Hypothesis — a testable claim stated as a belief, not yet validated.
  - Anchor — RESERVED. Only use when explicitly listed in the anchor
    section below.
</entity_guide>`;

const RELATIONSHIP_GUIDE_BLOCK = `<relationship_guide>
Use exactly these 18 types. PREFER DIRECTIONAL, SPECIFIC types.
Downrank \`relates_to\`, \`mentions\`, \`connected_to\` — only use when
nothing more precise fits.
Directional: leads_to, supports, enables, created, achieved, produced,
blocks, contradicts, risks, prevents, challenges, inhibits.
Structural: part_of, owns, associated_with.
Weak fallback: relates_to, mentions, connected_to.
</relationship_guide>`;

const DEFENSIVE_RULES_BLOCK = `<defensive_rules>
  1. NORMALISE NAMES. Fix mishearings, auto-caption errors, OCR
     artefacts, and common mis-spellings to canonical form (for people,
     organisations, products, technologies, legal citations, drug names,
     chemical compounds, academic institutions, domain terms-of-art). If
     you cannot confidently infer the canonical form, preserve the best
     phonetic guess and add tag \`needs_review\`.
  2. EXTRACT WELL-KNOWN ENTITIES. Never skip on grounds of being famous,
     obvious, or common knowledge. This applies across every domain.
  3. EXTRACT FRAMEWORKS AS CONCEPTS. In instructional or analytical
     content, the named framework / method / doctrine IS the highest-
     value extraction. Name it precisely, describe it self-containedly,
     extract each sub-component as its own Concept with \`part_of\`.
  4. EXTRACT TAKEAWAYS AS IMPERATIVES. Most instructional/advisory
     content has 3-10 prescriptive lessons. Phrase each as an imperative
     the user could follow.
  5. COLLAPSE DUPLICATES WITHIN A SINGLE EXTRACTION. Surface variants
     must collapse to a canonical entity; list alternates in \`aliases\`.
  6. DENSITY FLOOR. ~1 entity per 600 chars (instructional/analytical) or
     1 per 400 chars (meetings). Under-extraction is worse than over-
     extraction.
  7. RELATIONSHIP FLOOR. Every entity should have ≥1 relationship. If
     not, drop the entity or find a relationship.
  8. DESCRIPTIONS ARE 1-3 SENTENCES, SELF-CONTAINED, 40-400 chars. A
     future reader should understand the entity without the source.
</defensive_rules>`;

const EXAMPLES_BLOCK = `<examples>
These examples span domains deliberately. Study the shape, not the domain.

EXAMPLE 1 — instructional (finance/investing):
INPUT: "Most retail investors misuse the Sharpe ratio. Sharpe assumes
returns are normally distributed, which fails after 2008. A better
starting point is the Sortino ratio, which only penalises downside
volatility. Ray Dalio's All Weather portfolio uses risk parity, not
Sharpe optimisation, which is why it held up through the GFC when a
60/40 did not."
OUTPUT:
{"entities":[
  {"label":"Sharpe Ratio","entity_type":"Metric","description":"Risk-adjusted return metric dividing excess return by total standard deviation. Criticised here for assuming normally-distributed returns.","confidence":0.98,"tags":["finance","risk-metric"]},
  {"label":"Sortino Ratio","entity_type":"Metric","description":"Risk-adjusted return metric penalising only downside volatility; proposed as a better starting point than Sharpe.","confidence":0.95,"tags":["finance","risk-metric"]},
  {"label":"Risk Parity","entity_type":"Concept","description":"Portfolio construction method allocating by equal risk contribution rather than dollar weight or Sharpe optimisation.","confidence":0.95,"tags":["finance","portfolio-construction"]},
  {"label":"All Weather Portfolio","entity_type":"Concept","description":"Ray Dalio's risk-parity-based portfolio designed to perform across economic regimes; held up through the 2008 GFC.","confidence":0.95,"tags":["finance","portfolio"]},
  {"label":"60/40 Portfolio","entity_type":"Concept","description":"Standard 60% equities / 40% bonds allocation, cited as underperforming through the GFC relative to risk-parity.","confidence":0.95,"tags":["finance","portfolio"]},
  {"label":"Ray Dalio","entity_type":"Person","description":"Founder of Bridgewater Associates; cited as originator of the All Weather portfolio.","confidence":0.95,"tags":["investor"]},
  {"label":"2008 Global Financial Crisis","entity_type":"Event","description":"The 2008 financial crisis; stress test that exposed Sharpe-based and 60/40 strategies.","confidence":0.9,"tags":["macro","crisis"],"aliases":["GFC"]},
  {"label":"Prefer downside-volatility measures over total-volatility measures","entity_type":"Takeaway","description":"Retail investors should move from Sharpe toward downside-aware metrics like Sortino.","confidence":0.9,"tags":["finance","advisory"]}
],"relationships":[
  {"source":"Sortino Ratio","target":"Sharpe Ratio","relation_type":"challenges","evidence":"Proposed as better because it penalises only downside volatility."},
  {"source":"All Weather Portfolio","target":"Risk Parity","relation_type":"part_of","evidence":"Uses risk parity rather than Sharpe optimisation."},
  {"source":"Ray Dalio","target":"All Weather Portfolio","relation_type":"created","evidence":"Cited as author."},
  {"source":"All Weather Portfolio","target":"60/40 Portfolio","relation_type":"challenges","evidence":"Held up through GFC when 60/40 did not."},
  {"source":"2008 Global Financial Crisis","target":"Sharpe Ratio","relation_type":"contradicts","evidence":"Exposed Sharpe's assumption of normally-distributed returns."}
]}

EXAMPLE 2 — conversation (legal/professional services):
INPUT: "Priya: We need to decide on the Chen motion by Friday. If we file
under Rule 12(b)(6), we get a cleaner record but lose the counterclaim.
Marcus: The blocker is Discovery hasn't confirmed whether the 2019 email
chain is privileged. Ana is chasing it. Priya: Risk is if we don't have
privilege confirmed by Wednesday we miss the filing window."
OUTPUT:
{"entities":[
  {"label":"Priya Shah","entity_type":"Person","description":"Speaker driving the filing decision on the Chen motion.","confidence":0.85,"tags":["speaker","needs_review"]},
  {"label":"Marcus Lee","entity_type":"Person","description":"Speaker raising the privilege-review blocker.","confidence":0.85,"tags":["speaker","needs_review"]},
  {"label":"Ana Ortiz","entity_type":"Person","description":"Associate chasing Discovery on privilege for the 2019 email chain.","confidence":0.8,"tags":["needs_review"]},
  {"label":"Chen Motion","entity_type":"Project","description":"The motion under decision; trade-off between cleaner record and preserving the counterclaim.","confidence":0.95,"tags":["litigation"]},
  {"label":"Decide filing strategy on Chen motion by Friday","entity_type":"Decision","description":"Go/no-go decision required by Friday on whether to file under Rule 12(b)(6).","confidence":0.95,"tags":["litigation"]},
  {"label":"Rule 12(b)(6)","entity_type":"Concept","description":"Federal Rule of Civil Procedure 12(b)(6) — motion to dismiss for failure to state a claim.","confidence":0.95,"tags":["fed-civ-pro"]},
  {"label":"Unconfirmed privilege on 2019 email chain","entity_type":"Blocker","description":"Discovery has not confirmed whether a 2019 email chain is privileged, holding up the filing decision.","confidence":0.95,"tags":["discovery","privilege"]},
  {"label":"Miss filing window if privilege unresolved by Wednesday","entity_type":"Risk","description":"If privilege is not confirmed by Wednesday, the filing window is missed.","confidence":0.9,"tags":["deadline"]}
],"relationships":[
  {"source":"Unconfirmed privilege on 2019 email chain","target":"Chen Motion","relation_type":"blocks","evidence":"Filing decision held up by the privilege question."},
  {"source":"Ana Ortiz","target":"Unconfirmed privilege on 2019 email chain","relation_type":"associated_with","evidence":"Chasing Discovery."},
  {"source":"Miss filing window if privilege unresolved by Wednesday","target":"Unconfirmed privilege on 2019 email chain","relation_type":"risks","evidence":"Risk conditional on the blocker."},
  {"source":"Chen Motion","target":"Rule 12(b)(6)","relation_type":"part_of","evidence":"The proposed filing is under Rule 12(b)(6)."},
  {"source":"Priya Shah","target":"Decide filing strategy on Chen motion by Friday","relation_type":"owns","evidence":"Driving the decision."}
]}

EXAMPLE 3 — analytical (marketing/GTM):
INPUT: "HubSpot's latest report shows B2B SaaS companies under $10M ARR
get the worst ROI from paid search — roughly 0.4x payback at 12 months.
The fix isn't to bid smarter; it's to abandon paid search until you have
a repeatable organic motion. April Dunford makes the same point in
Obviously Awesome: positioning comes first, channels come second."
OUTPUT:
{"entities":[
  {"label":"HubSpot","entity_type":"Organization","description":"Marketing/CRM software company; source of the B2B SaaS paid-search ROI figure.","confidence":0.98,"tags":["saas","source"]},
  {"label":"B2B SaaS Paid Search ROI (sub-$10M ARR)","entity_type":"Metric","description":"Per HubSpot, sub-$10M ARR B2B SaaS companies see ~0.4x payback on paid search at 12 months.","confidence":0.9,"tags":["benchmark","paid-search"]},
  {"label":"April Dunford","entity_type":"Person","description":"Author of Obviously Awesome; argues positioning precedes channel selection.","confidence":0.95,"tags":["author","positioning"]},
  {"label":"Obviously Awesome","entity_type":"Document","description":"April Dunford's book on product positioning; cited as authority for positioning-before-channels.","confidence":0.95,"tags":["book","positioning"]},
  {"label":"Positioning Before Channels","entity_type":"Concept","description":"Principle that positioning must be solved before investing in channel acquisition.","confidence":0.9,"tags":["gtm","positioning"]},
  {"label":"Abandon paid search until organic motion is repeatable","entity_type":"Takeaway","description":"Prescriptive advice for sub-$10M ARR B2B SaaS: stop paid search until a repeatable organic acquisition motion exists.","confidence":0.9,"tags":["gtm","advisory"]}
],"relationships":[
  {"source":"B2B SaaS Paid Search ROI (sub-$10M ARR)","target":"Abandon paid search until organic motion is repeatable","relation_type":"supports","evidence":"0.4x payback is the empirical basis for the prescription."},
  {"source":"April Dunford","target":"Obviously Awesome","relation_type":"created","evidence":"Dunford authored the book."},
  {"source":"Obviously Awesome","target":"Positioning Before Channels","relation_type":"supports","evidence":"The book is cited as the source of the principle."},
  {"source":"Positioning Before Channels","target":"Abandon paid search until organic motion is repeatable","relation_type":"supports","evidence":"Tactical takeaway follows from the broader principle."},
  {"source":"HubSpot","target":"B2B SaaS Paid Search ROI (sub-$10M ARR)","relation_type":"produced","evidence":"HubSpot's report is the source of the metric."}
]}
</examples>`;

const OUTPUT_SCHEMA_BLOCK = `<output_schema>
Return ONLY valid JSON. No preamble, no markdown fences, no commentary.
{
  "content_type_detected": "meeting" | "tutorial" | "essay" | "code" | "research" | "other",
  "language": "ISO-639-1 code, e.g. 'en'",
  "primary_topic": "one-line summary of what this content is about",
  "entities": [
    {
      "label": "string, canonical name, 1-80 chars",
      "entity_type": "exactly one of the 24 entity types",
      "description": "1-3 self-contained sentences, 40-400 chars",
      "confidence": 0.0-1.0,
      "tags": ["lowercase", "hyphenated", "max-6"],
      "aliases": ["optional alternate surface forms seen in content"],
      "salience": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "source": "exact label of an entity above",
      "target": "exact label of an entity above",
      "relation_type": "exactly one of the 18 relationship types",
      "evidence": "quoted or paraphrased sentence, 20-300 chars",
      "confidence": 0.0-1.0
    }
  ]
}
</output_schema>`;

const FINAL_INSTRUCTIONS_BLOCK = `<final_instructions>
1. Read the full content before extracting.
2. Identify content_type_detected first — it determines priorities.
3. If instructional, extract the named framework/method FIRST and its
   sub-components as Concepts linked via \`part_of\`.
4. Then extract supporting people, organisations, products, metrics,
   documents, events, locations.
5. Then extract takeaways (as imperatives) and insights.
6. Build relationships — directional first, structural second, weak
   fallbacks last. Every entity needs ≥1 relationship.
7. Normalise names. Collapse duplicates.
8. Return ONLY the JSON. Any text outside the JSON is a failure.
</final_instructions>`;

// ─── DYNAMIC SECTIONS ──────────────────────────────────────────────────────

function buildUserContextBlock(profile: PromptUserProfile): string | null {
  const role = profile.professional_context?.role;
  const industry = profile.professional_context?.industry;
  const projects = profile.professional_context?.current_projects;
  const interests = profile.personal_interests?.topics;
  const learningGoals = profile.personal_interests?.learning_goals;
  const depth = profile.processing_preferences?.insight_depth;
  const focus = profile.processing_preferences?.relationship_focus;

  if (!role && !industry && !projects && !interests && !learningGoals && !depth && !focus) {
    return null;
  }

  let ctx = '<user_context>\nBias extraction toward entities and relationships this user is most likely to want to retrieve later. This is a hint, not a filter — do not skip entities that are not directly relevant.\n';
  if (role)          ctx += `- Role: ${role}\n`;
  if (industry)      ctx += `- Industry: ${industry}\n`;
  if (projects)      ctx += `- Current projects: ${projects}\n`;
  if (interests)     ctx += `- Interests: ${interests}\n`;
  if (learningGoals) ctx += `- Learning goals: ${learningGoals}\n`;
  if (depth)         ctx += `- Insight depth preference: ${depth}\n`;
  if (focus)         ctx += `- Relationship focus: ${focus}\n`;
  ctx += '</user_context>';
  return ctx;
}

function buildAnchorBlock(anchors: PromptAnchor[], emphasis: string): string | null {
  if (!anchors || anchors.length === 0) return null;

  const manual = anchors.filter(a => !a.isAuto).slice(0, 10);
  const auto   = anchors.filter(a =>  a.isAuto).slice(0, 10);

  const sections: string[] = [];

  if (manual.length > 0) {
    let block = `<anchor_context>\n${emphasisInstruction(emphasis)}\nWhen extracted entities plausibly relate to an anchor, add a relationship edge to the anchor by its exact label.\n`;
    for (const a of manual) {
      block += `- ${a.label} (${a.entity_type}): ${a.description}\n`;
    }
    block += '</anchor_context>';
    sections.push(block);
  }

  if (auto.length > 0) {
    let block = '<emerging_themes>\nThe system has detected the following emerging knowledge themes. Include connections to these naturally if they exist, but do not force them.\n';
    for (const a of auto) {
      block += `- ${a.label} (${a.entity_type}): ${a.description}\n`;
    }
    block += '</emerging_themes>';
    sections.push(block);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function buildSkillsBlock(skills: PromptSkillHint[] | undefined): string | null {
  if (!skills || skills.length === 0) return null;
  // Cap at 12 to keep the prompt bounded; skills past that contribute diminishing
  // signal and the most-confirmed/most-recent ones are expected to be passed first.
  const top = skills.slice(0, 12);
  let block = '<user_expertise>\nThe user has confirmed expertise in the following areas. When the source touches these areas, extract entities, frameworks, and relationships related to them with extra care — domain jargon, named methods, and sub-components are likely to be high-value. This is a hint, not a filter.\n';
  for (const s of top) {
    const meta = [s.domain, s.exposure_level].filter(Boolean).join(', ');
    block += meta ? `- ${s.label} (${meta})\n` : `- ${s.label}\n`;
  }
  block += '</user_expertise>';
  return block;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * Build the v2 extraction prompt as a single string. Pure: same inputs always
 * produce the same output. No I/O, no env reads.
 */
export function buildExtractionPrompt(config: PromptConfig): string {
  const sections: string[] = [];

  sections.push(ROLE_BLOCK);

  sections.push(`<extraction_mode>
Mode: ${config.mode}
${modeInstruction(config.mode)}
</extraction_mode>`);

  sections.push(CONTENT_TYPES_BLOCK);
  sections.push(ENTITY_GUIDE_BLOCK);
  sections.push(RELATIONSHIP_GUIDE_BLOCK);
  sections.push(DEFENSIVE_RULES_BLOCK);
  sections.push(EXAMPLES_BLOCK);

  if (config.userProfile) {
    const block = buildUserContextBlock(config.userProfile);
    if (block) sections.push(block);
  }

  const anchorBlock = buildAnchorBlock(config.anchors, config.anchorEmphasis);
  if (anchorBlock) sections.push(anchorBlock);

  const skillsBlock = buildSkillsBlock(config.activeSkills);
  if (skillsBlock) sections.push(skillsBlock);

  if (config.customInstructions && config.customInstructions.trim().length > 0) {
    sections.push(`<custom_instructions>\n${config.customInstructions.trim()}\n</custom_instructions>`);
  }

  sections.push(OUTPUT_SCHEMA_BLOCK);
  sections.push(FINAL_INSTRUCTIONS_BLOCK);

  return sections.join('\n\n');
}

/**
 * Compose the prompt and stamp it with the canonical PROMPT_VERSION. Callers
 * that persist the extraction (e.g. extraction_sessions inserts) should
 * record the returned `version` so we can correlate extraction quality with
 * prompt revisions over time.
 */
export function composeExtractionPrompt(config: PromptConfig): ComposedPrompt {
  return { prompt: buildExtractionPrompt(config), version: PROMPT_VERSION };
}
