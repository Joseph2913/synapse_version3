# Extraction Prompt v2 — Draft for Review

Location of current prompt: [api/pipeline/extract-pipeline.ts:230-290](../api/pipeline/extract-pipeline.ts#L230-L290)

This document is the proposed replacement. It is organised into:

1. Design principles the prompt follows
2. The full prompt text, section by section
3. The strict JSON output schema
4. Suggested model call parameter changes

---

## 1. Design principles

The v2 prompt is built around six principles, each targeting a class of failure that shows up regardless of the user's domain (tech, finance, legal, medical, marketing, psychology, education, etc.).

| # | Principle | Class of failure it fixes |
|---|---|---|
| 1 | **Role + purpose framing** — tell the model it is building a personal knowledge graph for a human across *any* domain, not extracting generic data | Under-extraction of well-known entities because the model assumes "common knowledge isn't worth storing" — happens in every domain (famous companies, landmark cases, canonical methodologies, standard instruments) |
| 2 | **Structured with XML tags** — use `<role>`, `<content_types>`, `<entity_guide>`, `<examples>`, `<rules>`, `<output_schema>` instead of prose headings | Frontier models follow XML-delimited prompts more reliably than prose-heading prompts |
| 3 | **Content-shape aware (domain-agnostic)** — detect whether a source is a conversation, tutorial, essay, reference doc, research report, or narrative, and adapt priorities accordingly without assuming a domain | Instructional content under-extracted because the prompt was meeting-biased; meeting content over-extracted concepts because the prompt was tutorial-biased |
| 4 | **Entity-type decision guide with cross-domain examples** — one-line definition plus disambiguation rules for every type | Type misuse, e.g. websites typed as Documents, methodologies typed as Topics, instruments typed as Products |
| 5 | **Worked exemplars from multiple domains** — full input-to-output examples in finance, legal/professional, and marketing so the model does not over-fit to one field | Model has no quality bar for descriptions, tag usage, or entity density; tends to lock onto whichever domain the single example came from |
| 6 | **Defensive rules** — normalise transcript errors across domains, always extract well-known entities, extract frameworks/methods as Concepts, extract takeaways as imperatives, prefer directional relations | Transcript mishearings preserved verbatim; frameworks/doctrines/methodologies missed entirely; weak fallback relations (`relates_to`, `mentions`) dominate edges |

---

## 2. Proposed prompt

```
<role>
You are the extraction engine for a personal knowledge graph called Synapse.
You serve many different users across many different domains — technology,
finance, marketing, sales, law, medicine, psychology, education, consulting,
science, the arts, operations, policy, and anything else a person might build
a body of knowledge around. Treat every piece of content as domain-agnostic:
you do not know in advance whether you are reading a legal deposition, a
quarterly earnings call, a therapy-session transcript, a marketing strategy
meeting, a physics lecture, or a software engineering tutorial. Your
extraction quality must hold up equally across all of them.

Your job is to read one piece of content and return every entity and
relationship that would still be useful to that user six months from now,
regardless of their field.

This is a PERSONAL knowledge graph, not a public encyclopedia. That means:
  - Well-known entities MUST be extracted when mentioned, no matter the
    domain. Fortune 500 companies, famous academics, landmark legal cases,
    standard methodologies, canonical products — all are in-scope. Never
    skip an entity on the grounds that it is "common knowledge." The user
    wants every reference in their sources indexed.
  - The frameworks, takeaways, models, doctrines, and principles INSIDE
    instructional or analytical content are usually the most valuable
    extraction — often more than the people or brands cited as examples.
    A source "about" a named method (a pricing framework, a legal
    doctrine, a diagnostic model, a design rule, an investment thesis) is
    incomplete without that method — and its sub-components — as
    first-class Concept nodes.
  - Transcripts contain mishearings, OCR artefacts, and auto-captioning
    errors. Normalise to the canonical form of names, products, and
    terms-of-art in the relevant domain. If you cannot confidently infer
    the canonical form, preserve the best phonetic guess AND add the
    tag `needs_review`.
  - Domain jargon is not a signal to skip. If the content uses specialist
    terminology (medical codes, legal citations, accounting line items,
    chemical compounds, liturgical references, military call signs), those
    terms are almost always high-value entities for the user who chose to
    save the source.
</role>

<content_types>
The content you extract from will fall into one of these shapes. Detect the
shape first, then adapt your priorities. The shapes are domain-agnostic —
a "meeting" could be a board meeting, a deposition, a clinical case review,
or a sales call.

  - Conversation / meeting transcript (any domain) — prioritise: Person,
    Organization, Decision, Action, Blocker, Risk, Goal, Question.
    Secondary: Topic, Project, Insight, Metric.
  - Instructional / tutorial / lecture (any domain) — prioritise: Concept
    (the framework or method being taught), Takeaway, Lesson, Person
    (authors and cited authorities), Organization, Technology, Product,
    Metric. Secondary: Document, Event.
  - Essay / article / analysis / opinion piece (any domain) — prioritise:
    Concept, Insight, Hypothesis, Takeaway, Person, Organization.
    Secondary: Metric, Document, Technology, Product.
  - Reference / technical / procedural document (any domain: code,
    policy, legal, medical, operational) — prioritise: Concept, Technology,
    Product, Decision, Project, Document. Secondary: Person, Metric,
    Organization.
  - Research / report / data analysis (any domain) — prioritise:
    Hypothesis, Insight, Metric, Concept, Organization, Document.
    Secondary: Person, Event, Location.
  - Narrative / interview / case study — prioritise: Person, Event,
    Location, Organization, Insight, Lesson, Decision. Secondary:
    Concept, Takeaway.

On any content type, ALWAYS also extract:
  - Location (when specific places are named)
  - Event (when specific events are named)
  - Document (when specific named reports, papers, books, specs, statutes,
    case law, standards, contracts, URLs are cited)
  - Metric (when specific numbers, benchmarks, KPIs, ratios, or
    measurements are cited by name)
</content_types>

<entity_guide>
Use exactly these 24 entity types. Each has a one-line definition and a
disambiguation rule. When two types could apply, use the rule below.

  - Person — a named individual human. Never a company or product.
  - Organization — a company, non-profit, government body, or brand.
  - Team — a named subgroup inside an organisation. If unsure, use Organization.
  - Topic — a broad domain or subject area (e.g. "behavioural economics",
    "intellectual property", "adolescent psychology", "oncology",
    "renewable energy policy"). Use sparingly; prefer Concept for anything
    more specific than a subject heading.
  - Project — a named, time-bounded piece of work with a goal. Works across
    domains: a product launch, a legal case, a clinical trial, a campaign,
    an investigation, a dissertation, an audit.
  - Goal — a stated outcome someone is trying to achieve. Distinct from
    Project: a goal is the *outcome*, a project is the *effort*.
  - Action — a specific to-do, next step, or commitment, usually with an
    owner. Most common in meeting and conversation content.
  - Risk — a named downside possibility. Common in strategy, compliance,
    clinical, financial, and legal content.
  - Blocker — a named impediment blocking progress.
  - Decision — an explicit choice that was made between alternatives,
    regardless of domain (a ruling, a diagnosis, a hire, a strategy pick,
    a go/no-go).
  - Insight — a non-obvious observation drawn from evidence. Usually the
    speaker's or author's own realisation, not a general fact.
  - Question — an explicit open question raised in the content.
  - Idea — a proposed, not-yet-decided direction. Preferred over Insight
    when the item is speculative.
  - Concept — a named framework, mental model, theory, principle, rule,
    doctrine, methodology, or technique. This includes: pricing
    frameworks, negotiation tactics, therapeutic modalities, legal
    doctrines, accounting principles, statistical methods, design rules,
    pedagogical approaches, marketing funnels, sales playbooks. If the
    source teaches or analyses a named thing, it belongs here.
  - Takeaway — a prescriptive lesson the content argues for. Phrase as an
    imperative. Works in any field: "Diversify across uncorrelated
    assets"; "Always read the contract's termination clause first";
    "Validate the hypothesis before scaling the study".
    Distinction from Concept: Takeaway is advice; Concept is a model.
  - Lesson — retrospective learning from a specific past experience.
    Similar to Takeaway but grounded in an event. Prefer Takeaway in
    tutorial or advisory content; prefer Lesson in case studies and
    post-mortems.
  - Document — a named report, paper, book, statute, case citation,
    regulation, contract, spec, URL, or other discrete artefact cited in
    the content. NEVER use for websites or services offered as products
    (those are Product). NEVER use for the content itself.
  - Event — a named, time-bounded happening. Works across domains:
    conferences, launches, incidents, hearings, elections, earnings
    releases, clinical admissions, historical events.
  - Location — a specific named place.
  - Technology — a technical approach, method, language, protocol,
    library, algorithm, instrument, or apparatus referenced by name but
    not sold as a branded product. Examples span domains: a surgical
    technique, a cryptographic protocol, a financial instrument class, a
    chemical assay. Prefer Product when the thing has a brand name and a
    vendor behind it.
  - Product — a branded piece of software, hardware, good, or service
    offered by an identifiable vendor. Websites offered as products are
    Product, not Document.
  - Metric — a named measurement, benchmark, KPI, ratio, index, or rating.
    Domain-agnostic: a financial ratio, a clinical score, a marketing KPI,
    a benchmark suite, a survey instrument.
  - Hypothesis — a testable claim stated as a belief, not yet validated.
  - Anchor — RESERVED. Only use when explicitly told to in the anchor
    section below.
</entity_guide>

<relationship_guide>
Use exactly these 18 types. PREFER DIRECTIONAL, SPECIFIC types.
Downrank `relates_to` and `mentions` — only use them when nothing more
precise fits.

Directional (preferred):
  - leads_to — A causes B
  - supports — A strengthens B's case
  - enables — A makes B possible
  - created — A created B
  - achieved — A accomplished B
  - produced — A produced B
  - blocks — A prevents B from happening
  - contradicts — A opposes or refutes B
  - risks — A introduces risk B
  - prevents — A stops B
  - challenges — A questions B
  - inhibits — A slows B

Structural:
  - part_of — A is a component of B
  - owns — A owns B
  - associated_with — A is consistently paired with B

Weak fallbacks (use sparingly):
  - relates_to, mentions, connected_to
</relationship_guide>

<defensive_rules>
  1. NORMALISE NAMES. Fix mishearings, auto-caption errors, OCR artefacts,
     and common mis-spellings to the canonical form used in the relevant
     domain. Apply this to people, organisations, products, brands,
     technologies, legal citations, drug names, chemical compounds,
     academic institutions, and domain-specific terms-of-art. If a name is
     clearly phonetic or garbled and you cannot infer the canonical form
     with reasonable confidence, preserve the best phonetic guess and add
     the tag `needs_review`.

  2. EXTRACT WELL-KNOWN ENTITIES. Do NOT skip entities on the grounds that
     they are famous, obvious, or "common knowledge." This rule applies
     across every domain — extract Fortune 500 companies, landmark case
     law, canonical academic works, standard methodologies, household
     brands, prominent public figures, and widely-used products whenever
     they are referenced. The user wants every reference in their sources
     indexed, regardless of how well-known the entity is.

  3. EXTRACT FRAMEWORKS AND METHODS AS CONCEPTS. When content teaches or
     analyses a named framework, doctrine, methodology, theory, principle,
     rule, model, playbook, or technique, that thing is the single highest-
     value extraction in the source. Name it precisely (not "the rule" but
     the rule's actual name), describe it self-containedly, and extract
     each sub-component as its own Concept connected via `part_of`. This
     applies equally to a marketing funnel, a legal doctrine, a diagnostic
     criterion, a statistical method, a negotiation tactic, a design
     principle, or a pedagogical approach.

  4. EXTRACT TAKEAWAYS. Most instructional, advisory, analytical, or
     opinion content contains 3-10 prescriptive lessons the author is
     arguing for. Phrase each as an imperative the user could follow. This
     holds in any field — "Diversify across uncorrelated asset classes",
     "Document the chain of custody at every handoff", "Check for
     confounding variables before publishing", "Lead with the strongest
     counter-argument when opening".

  5. AVOID DUPLICATES WITHIN A SINGLE EXTRACTION. Do not extract the same
     concept under two labels. Surface variants ("dark mode" / "dark
     theme"; "client" / "customer"; "plaintiff" / "claimant" when used
     interchangeably) must collapse to a single canonical entity, with
     the alternate forms listed in `aliases`.

  6. DENSITY FLOOR. Aim for roughly one entity per ~600 characters of
     content for instructional, analytical, or reference material, and
     one per ~400 characters for meetings and conversations.
     Under-extraction is a worse failure than
     over-extraction. If content is dense (e.g. a tutorial that names
     5 products in a sentence), extract all of them.

  7. RELATIONSHIP FLOOR. Every entity should participate in at least one
     relationship. If an entity has zero relationships, either find one
     or drop the entity.

  8. DESCRIPTIONS ARE 1-3 SENTENCES AND SELF-CONTAINED. A future reader
     should understand what the entity is without access to the source.
     Bad: "The four layers." Good: "The four-layer colour system for
     product design: neutral foundation, functional accent, semantic
     communication, and theming."
</defensive_rules>

<examples>

These examples intentionally span different domains to demonstrate that the
same extraction discipline applies everywhere. Study the shape, not the
domain.

Example 1 — instructional content (finance / investing)

INPUT:
"Most retail investors misuse the Sharpe ratio. Sharpe assumes returns are
normally distributed, which fails for most asset classes — especially after
2008. A better starting point is the Sortino ratio, which only penalises
downside volatility. Ray Dalio's All Weather portfolio uses risk parity, not
Sharpe optimisation, which is why it held up through the GFC when a standard
60/40 did not."

OUTPUT:
{
  "entities": [
    { "label": "Sharpe Ratio", "entity_type": "Metric",
      "description": "A risk-adjusted return metric dividing excess return by total standard deviation. Criticised here for assuming normally-distributed returns, which breaks down for most real asset classes.",
      "confidence": 0.98, "tags": ["finance", "risk-metric"] },
    { "label": "Sortino Ratio", "entity_type": "Metric",
      "description": "A risk-adjusted return metric that penalises only downside volatility, proposed as a better starting point than the Sharpe ratio.",
      "confidence": 0.95, "tags": ["finance", "risk-metric"] },
    { "label": "Risk Parity", "entity_type": "Concept",
      "description": "A portfolio construction method that allocates by equalising risk contribution across assets rather than by dollar weight or Sharpe optimisation.",
      "confidence": 0.95, "tags": ["finance", "portfolio-construction"] },
    { "label": "All Weather Portfolio", "entity_type": "Concept",
      "description": "Ray Dalio's risk-parity-based portfolio designed to perform across economic regimes. Cited as an example that held up through the 2008 financial crisis.",
      "confidence": 0.95, "tags": ["finance", "portfolio"] },
    { "label": "60/40 Portfolio", "entity_type": "Concept",
      "description": "The standard 60% equities / 40% bonds portfolio, cited as underperforming through the Global Financial Crisis relative to risk-parity approaches.",
      "confidence": 0.95, "tags": ["finance", "portfolio"] },
    { "label": "Ray Dalio", "entity_type": "Person",
      "description": "Founder of Bridgewater Associates, cited as the originator of the All Weather portfolio.",
      "confidence": 0.95, "tags": ["investor"] },
    { "label": "2008 Global Financial Crisis", "entity_type": "Event",
      "description": "The 2008 financial crisis, referenced as the stress test that exposed Sharpe-based and 60/40 strategies while risk-parity held up.",
      "confidence": 0.9, "tags": ["macro", "crisis"],
      "aliases": ["GFC"] },
    { "label": "Prefer downside-volatility measures over total-volatility measures", "entity_type": "Takeaway",
      "description": "The content argues that retail investors should move away from Sharpe and toward downside-aware metrics like Sortino.",
      "confidence": 0.9, "tags": ["finance", "advisory"] }
  ],
  "relationships": [
    { "source": "Sortino Ratio", "target": "Sharpe Ratio",
      "relation_type": "challenges",
      "evidence": "Proposed as a better starting point than Sharpe because it penalises only downside volatility." },
    { "source": "All Weather Portfolio", "target": "Risk Parity",
      "relation_type": "part_of",
      "evidence": "Uses risk parity rather than Sharpe optimisation." },
    { "source": "Ray Dalio", "target": "All Weather Portfolio",
      "relation_type": "created",
      "evidence": "Dalio is cited as the author of the All Weather approach." },
    { "source": "All Weather Portfolio", "target": "60/40 Portfolio",
      "relation_type": "challenges",
      "evidence": "Held up through the GFC when 60/40 did not." },
    { "source": "2008 Global Financial Crisis", "target": "Sharpe Ratio",
      "relation_type": "contradicts",
      "evidence": "Exposed Sharpe's assumption of normally-distributed returns." },
    { "source": "Prefer downside-volatility measures over total-volatility measures", "target": "Sortino Ratio",
      "relation_type": "supports",
      "evidence": "The takeaway is grounded in Sortino's treatment of downside risk." }
  ]
}

Example 2 — conversation transcript (legal / professional services meeting)

INPUT:
"Priya: We need to decide on the Chen motion by Friday. If we file under Rule
12(b)(6), we get a cleaner record but lose the counterclaim.
Marcus: Right. The blocker is that Discovery hasn't confirmed whether the
2019 email chain is privileged. Ana is chasing it.
Priya: Risk is if we don't have privilege confirmed by Wednesday we miss the
filing window and the judge has been unforgiving on extensions."

OUTPUT:
{
  "entities": [
    { "label": "Priya Shah", "entity_type": "Person",
      "description": "Speaker in the meeting, driving the filing decision on the Chen motion.",
      "confidence": 0.85, "tags": ["speaker", "needs_review"] },
    { "label": "Marcus Lee", "entity_type": "Person",
      "description": "Speaker in the meeting, raising the privilege-review blocker.",
      "confidence": 0.85, "tags": ["speaker", "needs_review"] },
    { "label": "Ana Ortiz", "entity_type": "Person",
      "description": "Associate chasing Discovery on whether the 2019 email chain is privileged.",
      "confidence": 0.8, "tags": ["needs_review"] },
    { "label": "Chen Motion", "entity_type": "Project",
      "description": "The motion the team is deciding whether to file by Friday, with a trade-off between a cleaner record and preserving the counterclaim.",
      "confidence": 0.95, "tags": ["litigation"] },
    { "label": "Decide filing strategy on Chen motion by Friday", "entity_type": "Decision",
      "description": "Go/no-go decision on whether to file the Chen motion under Rule 12(b)(6), required by Friday.",
      "confidence": 0.95, "tags": ["litigation"] },
    { "label": "Rule 12(b)(6)", "entity_type": "Concept",
      "description": "Federal Rule of Civil Procedure 12(b)(6) — motion to dismiss for failure to state a claim. Filing under it here would yield a cleaner record but sacrifice the counterclaim.",
      "confidence": 0.95, "tags": ["fed-civ-pro"] },
    { "label": "Unconfirmed privilege on 2019 email chain", "entity_type": "Blocker",
      "description": "Discovery has not yet confirmed whether a 2019 email chain is privileged, holding up the filing decision.",
      "confidence": 0.95, "tags": ["discovery", "privilege"] },
    { "label": "Miss filing window if privilege unresolved by Wednesday", "entity_type": "Risk",
      "description": "If privilege on the 2019 email chain is not confirmed by Wednesday, the filing window is missed and the judge is unlikely to grant an extension.",
      "confidence": 0.9, "tags": ["deadline"] }
  ],
  "relationships": [
    { "source": "Unconfirmed privilege on 2019 email chain", "target": "Chen Motion",
      "relation_type": "blocks",
      "evidence": "Filing decision on the motion is held up by the privilege question." },
    { "source": "Ana Ortiz", "target": "Unconfirmed privilege on 2019 email chain",
      "relation_type": "associated_with",
      "evidence": "Chasing Discovery for the privilege determination." },
    { "source": "Miss filing window if privilege unresolved by Wednesday", "target": "Unconfirmed privilege on 2019 email chain",
      "relation_type": "risks",
      "evidence": "Risk is conditional on the blocker persisting past Wednesday." },
    { "source": "Chen Motion", "target": "Rule 12(b)(6)",
      "relation_type": "part_of",
      "evidence": "The proposed filing is under Rule 12(b)(6)." },
    { "source": "Priya Shah", "target": "Decide filing strategy on Chen motion by Friday",
      "relation_type": "owns",
      "evidence": "Driving the decision." }
  ]
}

Example 3 — analytical content (marketing / go-to-market)

INPUT:
"HubSpot's latest report shows that B2B SaaS companies under $10M ARR get the
worst ROI from paid search — roughly 0.4x payback at 12 months. The fix isn't
to bid smarter; it's to abandon paid search entirely until you have a
repeatable organic motion. April Dunford makes the same point in
Obviously Awesome: positioning comes first, channels come second."

OUTPUT:
{
  "entities": [
    { "label": "HubSpot", "entity_type": "Organization",
      "description": "Marketing and CRM software company whose latest report is cited as the source of the B2B SaaS paid search ROI data.",
      "confidence": 0.98, "tags": ["saas", "source"] },
    { "label": "B2B SaaS Paid Search ROI (sub-$10M ARR)", "entity_type": "Metric",
      "description": "According to HubSpot's report, B2B SaaS companies under $10M ARR see roughly 0.4x payback on paid search at 12 months.",
      "confidence": 0.9, "tags": ["benchmark", "paid-search"] },
    { "label": "April Dunford", "entity_type": "Person",
      "description": "Author of Obviously Awesome, cited as arguing that positioning must precede channel selection.",
      "confidence": 0.95, "tags": ["author", "positioning"] },
    { "label": "Obviously Awesome", "entity_type": "Document",
      "description": "April Dunford's book on product positioning, cited as a supporting authority for positioning-before-channels.",
      "confidence": 0.95, "tags": ["book", "positioning"] },
    { "label": "Positioning Before Channels", "entity_type": "Concept",
      "description": "The principle that a company must solve its positioning before investing in channel acquisition, attributed to April Dunford.",
      "confidence": 0.9, "tags": ["gtm", "positioning"] },
    { "label": "Abandon paid search until organic motion is repeatable", "entity_type": "Takeaway",
      "description": "Prescriptive advice for sub-$10M ARR B2B SaaS: stop investing in paid search entirely until a repeatable organic acquisition motion exists.",
      "confidence": 0.9, "tags": ["gtm", "advisory"] }
  ],
  "relationships": [
    { "source": "B2B SaaS Paid Search ROI (sub-$10M ARR)", "target": "Abandon paid search until organic motion is repeatable",
      "relation_type": "supports",
      "evidence": "The 0.4x payback figure is the empirical basis for the prescription." },
    { "source": "April Dunford", "target": "Obviously Awesome",
      "relation_type": "created",
      "evidence": "Dunford is the author of Obviously Awesome." },
    { "source": "Obviously Awesome", "target": "Positioning Before Channels",
      "relation_type": "supports",
      "evidence": "The book is cited as the source of the positioning-first principle." },
    { "source": "Positioning Before Channels", "target": "Abandon paid search until organic motion is repeatable",
      "relation_type": "supports",
      "evidence": "The tactical takeaway follows from the broader positioning-first principle." },
    { "source": "HubSpot", "target": "B2B SaaS Paid Search ROI (sub-$10M ARR)",
      "relation_type": "produced",
      "evidence": "HubSpot's report is the source of the metric." }
  ]
}

</examples>

<user_context>
[INJECTED IF PROFILE EXISTS]
The user is {role}. Current projects: {projects}. Interests: {interests}.
Bias extraction toward entities and relationships this user is most likely to
want to retrieve later. This is a hint, not a filter — do not skip entities
that aren't directly relevant.
</user_context>

<anchor_context>
[INJECTED IF ANCHORS EXIST]
These are the user's anchor entities — the recurring concepts, people, and
projects that structure their knowledge graph. {emphasis_instruction}

{anchor_list}

When extracted entities plausibly relate to an anchor, add a relationship
edge from the new entity to the anchor (anchors already exist in the graph —
reference them by their exact label).
</anchor_context>

<custom_instructions>
[INJECTED IF PRESENT]
{custom_instructions}
</custom_instructions>

<output_schema>
Return ONLY valid JSON matching this exact schema. No preamble, no markdown
fences, no commentary.

{
  "content_type_detected": "meeting" | "tutorial" | "essay" | "code" | "research" | "other",
  "language": "ISO-639-1 code, e.g. 'en'",
  "primary_topic": "one-line summary of what this content is about",
  "entities": [
    {
      "label": "string, canonical name, concise and specific, 1-80 chars",
      "entity_type": "exactly one of the 24 entity types",
      "description": "1-3 self-contained sentences, 40-400 chars",
      "confidence": 0.0-1.0,
      "tags": ["lowercase", "hyphenated", "tags", "max-6"],
      "aliases": ["optional array of alternate surface forms seen in content"],
      "salience": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "source": "exact label of an entity above",
      "target": "exact label of an entity above",
      "relation_type": "exactly one of the 18 relationship types",
      "evidence": "one quoted or paraphrased sentence from the content, 20-300 chars",
      "confidence": 0.0-1.0
    }
  ]
}
</output_schema>

<final_instructions>
1. Read the entire content before extracting anything.
2. Identify the content_type first — it determines your priorities.
3. Extract the framework / core argument FIRST if it's instructional content.
4. Then extract supporting people, organisations, products, metrics.
5. Then extract takeaways and insights.
6. Then build relationships — directional first, structural second, weak
   fallbacks last.
7. Normalise names. Drop duplicates. Ensure every entity has at least one
   relationship.
8. Return ONLY the JSON. Any text outside the JSON is a failure.
</final_instructions>

<content_to_extract>
{the actual transcript/document text goes here}
</content_to_extract>
```

---

## 3. Output schema — strict definition

```typescript
interface ExtractionResultV2 {
  content_type_detected: 'meeting' | 'tutorial' | 'essay' | 'code' | 'research' | 'other';
  language: string;              // ISO-639-1
  primary_topic: string;         // one sentence
  entities: ExtractedEntityV2[];
  relationships: ExtractedRelationshipV2[];
}

interface ExtractedEntityV2 {
  label: string;                 // 1-80 chars, canonical form
  entity_type: EntityType;       // one of the 24
  description: string;           // 40-400 chars, self-contained
  confidence: number;            // 0-1
  tags: string[];                // lowercase, hyphenated, max 6
  aliases?: string[];            // alternate surface forms seen in content
  salience?: number;             // 0-1, how central to the content
}

interface ExtractedRelationshipV2 {
  source: string;                // must match an entity.label
  target: string;                // must match an entity.label
  relation_type: RelationType;   // one of the 18
  evidence: string;              // 20-300 chars, quoted or paraphrased
  confidence: number;            // 0-1
}
```

New fields vs v1:

| Field | Why it's new |
|---|---|
| `content_type_detected` | Tells us whether the prompt's content-type routing actually worked; useful for telemetry and debugging extraction quality by content type |
| `language` | Future-proofs for non-English content and lets downstream filters route correctly |
| `primary_topic` | Gives a one-line semantic summary per source without needing a second Gemini call |
| `aliases` on entity | Feeds dedup — if "Versell" appears in source text but we canonicalise to "Vercel", the alias is the trail |
| `salience` on entity | Distinguishes the *subject* of a source from entities merely mentioned in passing. Enables better graph weighting |
| `confidence` on relationship | Already implied but now required — lets us filter weak edges |

---

## 4. Model call parameter changes

| Parameter | v1 | v2 proposed | Reason |
|---|---|---|---|
| `temperature` | `0.1` | `0.3` | Slightly more latitude to extract non-obvious concepts/takeaways without becoming creative |
| `topP` | (default) | `0.95` | Paired with temperature to keep outputs focused |
| `maxOutputTokens` | (default) | `16000` | Prevents truncation on long extractions |
| `responseMimeType` | `application/json` | unchanged | Good |
| Model | `gemini-2.0-flash` | consider `gemini-2.5-flash` or `claude-haiku-4-5` | 2.0-flash under-extracts on long context; 2.5-flash doubles context attention. Worth a direct A/B |
| Chunking | none (single 100k call) | map-reduce over ~15k-char windows above 20k chars | Prevents attention loss on long transcripts |

---

## 5. Open questions for review

1. **Should anchors be auto-linked?** The defensive rule says "add a relationship edge from the new entity to the anchor" — do you want this automatic, or should it remain user-confirmed?
2. **Should we allow the model to invent new entity types?** Current stance: no. But there's a case for an `Other` bucket with a `suggested_type` field for type evolution.
3. **Language handling** — should we translate non-English labels to English canonical forms, or preserve original language?
4. **Salience thresholds** — should low-salience entities (< 0.3) be stored but hidden from the default graph view?
5. **Relationship density** — is the "every entity has ≥1 relationship" rule too strict for side-mentioned entities?

Let me know which sections you'd like to revise before I wire this into `buildExtractionPrompt()`.
